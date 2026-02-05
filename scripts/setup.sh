#!/bin/bash

# CodeBox Setup Script
# Detects system capabilities and sets up the appropriate execution environment

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "========================================"
echo "  CodeBox Setup Script"
echo "========================================"
echo ""

# Detect OS
OS=$(uname -s)
ARCH=$(uname -m)

echo "Detected OS: $OS"
echo "Detected Architecture: $ARCH"
echo ""

# Check for Firecracker compatibility
FIRECRACKER_COMPATIBLE=false
FIRECRACKER_REASON=""

check_firecracker_compatibility() {
    # Must be Linux
    if [ "$OS" != "Linux" ]; then
        FIRECRACKER_REASON="Firecracker requires Linux (detected: $OS)"
        return 1
    fi

    # Must be x86_64 or aarch64
    if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ]; then
        FIRECRACKER_REASON="Firecracker requires x86_64 or aarch64 (detected: $ARCH)"
        return 1
    fi

    # Check for KVM support
    if [ ! -e /dev/kvm ]; then
        FIRECRACKER_REASON="KVM not available (/dev/kvm not found)"
        return 1
    fi

    # Check KVM permissions
    if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
        FIRECRACKER_REASON="No read/write access to /dev/kvm (try: sudo usermod -aG kvm \$USER)"
        return 1
    fi

    # Check if nested virtualization is enabled (for VMs)
    if grep -q "^flags.*vmx\|^flags.*svm" /proc/cpuinfo 2>/dev/null; then
        return 0
    fi

    # Alternative check for KVM
    if [ -c /dev/kvm ]; then
        return 0
    fi

    FIRECRACKER_REASON="CPU virtualization extensions not detected"
    return 1
}

echo "Checking Firecracker compatibility..."
if check_firecracker_compatibility; then
    FIRECRACKER_COMPATIBLE=true
    echo -e "${GREEN}✓ System is Firecracker compatible${NC}"
else
    echo -e "${YELLOW}✗ Firecracker not available: $FIRECRACKER_REASON${NC}"
    echo -e "${YELLOW}  Falling back to Docker${NC}"
fi
echo ""

# Check Docker
echo "Checking Docker..."
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓ Docker is installed${NC}"
    if docker info &> /dev/null; then
        echo -e "${GREEN}✓ Docker daemon is running${NC}"
    else
        echo -e "${RED}✗ Docker daemon is not running${NC}"
        echo "  Please start Docker and run this script again"
        exit 1
    fi
else
    echo -e "${RED}✗ Docker is not installed${NC}"
    if [ "$FIRECRACKER_COMPATIBLE" = false ]; then
        echo "  Docker is required. Please install Docker and run this script again"
        exit 1
    fi
fi
echo ""

# Create .env file
echo "Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env

    # Set executor type based on compatibility
    if [ "$FIRECRACKER_COMPATIBLE" = true ]; then
        echo "EXECUTOR_TYPE=firecracker" >> .env
        echo -e "${GREEN}✓ Set EXECUTOR_TYPE=firecracker${NC}"
    else
        echo "EXECUTOR_TYPE=docker" >> .env
        echo -e "${GREEN}✓ Set EXECUTOR_TYPE=docker${NC}"
    fi
else
    echo -e "${YELLOW}  .env already exists, skipping${NC}"
fi
echo ""

# Setup based on executor type
if [ "$FIRECRACKER_COMPATIBLE" = true ]; then
    echo "Setting up Firecracker..."

    # Download Firecracker binary
    FC_VERSION="v1.6.0"
    FC_ARCH=$ARCH

    if [ ! -f /usr/local/bin/firecracker ]; then
        echo "Downloading Firecracker ${FC_VERSION}..."
        curl -sSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${FC_ARCH}.tgz" -o /tmp/firecracker.tgz
        tar -xzf /tmp/firecracker.tgz -C /tmp
        sudo mv /tmp/release-${FC_VERSION}-${FC_ARCH}/firecracker-${FC_VERSION}-${FC_ARCH} /usr/local/bin/firecracker
        sudo chmod +x /usr/local/bin/firecracker
        rm -rf /tmp/firecracker.tgz /tmp/release-${FC_VERSION}-${FC_ARCH}
        echo -e "${GREEN}✓ Firecracker installed${NC}"
    else
        echo -e "${GREEN}✓ Firecracker already installed${NC}"
    fi

    # Create directories for Firecracker
    sudo mkdir -p /var/lib/codebox/firecracker/{kernels,rootfs,sockets}
    sudo chown -R $USER:$USER /var/lib/codebox

    # Download kernel
    if [ ! -f /var/lib/codebox/firecracker/kernels/vmlinux ]; then
        echo "Downloading Linux kernel..."
        curl -sSL "https://s3.amazonaws.com/spec.ccfc.min/ci-artifacts/kernels/${FC_ARCH}/vmlinux-5.10.217" -o /var/lib/codebox/firecracker/kernels/vmlinux
        echo -e "${GREEN}✓ Kernel downloaded${NC}"
    else
        echo -e "${GREEN}✓ Kernel already exists${NC}"
    fi

    # Build rootfs images
    echo ""
    echo "Building Firecracker rootfs images..."
    echo "(This may take a while on first run)"

    ./scripts/build-firecracker-rootfs.sh

    echo -e "${GREEN}✓ Firecracker setup complete${NC}"
else
    echo "Setting up Docker..."

    # Build Docker images
    echo "Building Docker images..."
    ./scripts/build-images.sh

    echo -e "${GREEN}✓ Docker setup complete${NC}"
fi

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
if [ "$FIRECRACKER_COMPATIBLE" = true ]; then
    echo -e "Executor: ${GREEN}Firecracker${NC} (faster, stronger isolation)"
else
    echo -e "Executor: ${YELLOW}Docker${NC} (compatible mode)"
fi
echo ""
echo "Next steps:"
echo "  1. Review .env file and adjust settings"
echo "  2. Run: docker-compose up -d"
echo "  3. Test: curl http://localhost:3000/health"
echo ""
