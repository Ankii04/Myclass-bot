FROM node:20-slim

# Install Chromium and timezone dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-freefont-ttf \
    tzdata \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Timezone to IST
ENV TZ="Asia/Kolkata"

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the bot
CMD ["node", "server.js"]
