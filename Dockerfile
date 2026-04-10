# Use lightweight Node.js image
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Run the bot
CMD ["npm", "start"]
