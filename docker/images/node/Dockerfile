FROM node:18-slim

# Node image already has user 'node' with UID 1000, use it
# Create working directory
RUN mkdir -p /box && chown node:node /box

# Set working directory
WORKDIR /box

# Switch to non-root user
USER node

# Keep container alive (will be overridden at runtime)
CMD ["sleep", "infinity"]
