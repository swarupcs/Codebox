#!/bin/bash

# Build all language runtime images

set -e

echo "Building Python 3.8 image..."
docker build -t codebox/python:3.8 docker/images/python/

echo "Building Node.js 18 image..."
docker build -t codebox/node:18 docker/images/node/

echo "Building GCC 9 image..."
docker build -t codebox/gcc:9 docker/images/gcc/

echo "Building Java 17 image..."
docker build -t codebox/java:17 docker/images/java/

echo "All images built successfully!"
echo ""
echo "Images:"
docker images | grep codebox
