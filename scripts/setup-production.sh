#!/bin/bash

# CodeBox Production Setup Script for DigitalOcean
# Usage: ./scripts/setup-production.sh <domain>
# Example: ./scripts/setup-production.sh api.codebox.example.com

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check arguments
if [ -z "$1" ]; then
    echo -e "${RED}Error: Domain is required${NC}"
    echo ""
    echo "Usage: $0 <domain>"
    echo "Example: $0 api.codebox.example.com"
    exit 1
fi

DOMAIN=$1

echo "========================================"
echo "  CodeBox Production Setup"
echo "========================================"
echo ""
echo -e "Domain: ${GREEN}$DOMAIN${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Warning: Running as root. Consider using a non-root user with sudo.${NC}"
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
else
    OS=$(uname -s)
fi

echo "Detected OS: $OS"
echo ""

# Step 1: System updates
echo -e "${GREEN}[1/7] Updating system packages...${NC}"
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get upgrade -y
elif command -v yum &> /dev/null; then
    sudo yum update -y
fi

# Step 2: Install Docker
echo -e "${GREEN}[2/7] Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✓ Docker installed${NC}"
else
    echo -e "${GREEN}✓ Docker already installed${NC}"
fi

# Start Docker
sudo systemctl enable docker
sudo systemctl start docker

# Step 3: Install Docker Compose
echo -e "${GREEN}[3/7] Installing Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin || {
        COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
        sudo curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
    }
    echo -e "${GREEN}✓ Docker Compose installed${NC}"
else
    echo -e "${GREEN}✓ Docker Compose already installed${NC}"
fi

# Step 4: Configure firewall
echo -e "${GREEN}[4/7] Configuring firewall...${NC}"
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp    # SSH
    sudo ufw allow 80/tcp    # HTTP
    sudo ufw allow 443/tcp   # HTTPS
    sudo ufw --force enable
    echo -e "${GREEN}✓ Firewall configured (SSH, HTTP, HTTPS)${NC}"
else
    echo -e "${YELLOW}UFW not found, skipping firewall setup${NC}"
fi

# Step 5: Check for KVM/Firecracker support
echo -e "${GREEN}[5/7] Checking Firecracker compatibility...${NC}"
EXECUTOR_TYPE="docker"
if [ -e /dev/kvm ]; then
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        EXECUTOR_TYPE="auto"
        echo -e "${GREEN}✓ KVM available - Firecracker will be used${NC}"

        # Download Firecracker
        FC_VERSION="v1.6.0"
        ARCH=$(uname -m)
        if [ ! -f /usr/local/bin/firecracker ]; then
            echo "Downloading Firecracker..."
            curl -sSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" -o /tmp/firecracker.tgz
            tar -xzf /tmp/firecracker.tgz -C /tmp
            sudo mv /tmp/release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH} /usr/local/bin/firecracker
            sudo chmod +x /usr/local/bin/firecracker
            rm -rf /tmp/firecracker.tgz /tmp/release-${FC_VERSION}-${ARCH}
        fi

        # Setup Firecracker directories
        sudo mkdir -p /var/lib/codebox/firecracker/{kernels,rootfs,sockets}
        sudo chown -R $USER:$USER /var/lib/codebox

        # Download kernel
        if [ ! -f /var/lib/codebox/firecracker/kernels/vmlinux ]; then
            echo "Downloading Linux kernel for Firecracker..."
            curl -sSL "https://s3.amazonaws.com/spec.ccfc.min/ci-artifacts/kernels/${ARCH}/vmlinux-5.10.217" -o /var/lib/codebox/firecracker/kernels/vmlinux
        fi
    else
        echo -e "${YELLOW}KVM found but not accessible. Add user to kvm group:${NC}"
        echo "  sudo usermod -aG kvm $USER"
    fi
else
    echo -e "${YELLOW}KVM not available - using Docker executor${NC}"
fi

# Step 6: Create .env file
echo -e "${GREEN}[6/7] Creating configuration...${NC}"
AUTH_TOKEN=$(openssl rand -hex 32)
GRAFANA_PASSWORD=$(openssl rand -hex 16)

cat > .env << EOF
# Production Configuration
NODE_ENV=production
DOMAIN=${DOMAIN}

# Authentication
AUTH_TOKEN=${AUTH_TOKEN}

# Executor
EXECUTOR_TYPE=${EXECUTOR_TYPE}

# Worker
WORKER_CONCURRENCY=4

# Grafana
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}

# Redis
REDIS_URL=redis://redis:6379
EOF

echo -e "${GREEN}✓ Configuration created${NC}"

# Update Caddyfile with domain
sed -i "s/{\$DOMAIN:localhost}/${DOMAIN}/" Caddyfile 2>/dev/null || \
    sed -i '' "s/{\$DOMAIN:localhost}/${DOMAIN}/" Caddyfile

# Step 7: Build and start services
echo -e "${GREEN}[7/7] Building and starting services...${NC}"

# Build language images
echo "Building language runtime images..."
./scripts/build-images.sh

# Build and start with docker-compose
echo "Starting services..."
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "========================================"
echo -e "  ${GREEN}Setup Complete!${NC}"
echo "========================================"
echo ""
echo -e "Domain:        ${GREEN}https://${DOMAIN}${NC}"
echo -e "Executor:      ${GREEN}${EXECUTOR_TYPE}${NC}"
echo ""
echo -e "API Token:     ${YELLOW}${AUTH_TOKEN}${NC}"
echo -e "               (save this - you'll need it for API requests)"
echo ""
echo -e "Grafana:       http://localhost:3001 (via SSH tunnel)"
echo -e "Grafana Pass:  ${YELLOW}${GRAFANA_PASSWORD}${NC}"
echo ""
echo "Prometheus:    http://localhost:9090 (via SSH tunnel)"
echo ""
echo "========================================"
echo "  Quick Test"
echo "========================================"
echo ""
echo "curl https://${DOMAIN}/health"
echo ""
echo "curl -X POST https://${DOMAIN}/submissions?wait=true \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'X-Auth-Token: ${AUTH_TOKEN}' \\"
echo "  -d '{\"source_code\": \"print(1+1)\", \"language_id\": 71}'"
echo ""
echo "========================================"
echo "  Access Grafana via SSH Tunnel"
echo "========================================"
echo ""
echo "ssh -L 3001:localhost:3001 user@${DOMAIN}"
echo "Then open: http://localhost:3001"
echo ""
