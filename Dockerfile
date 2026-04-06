FROM node:18-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p uploads

EXPOSE 8080

CMD ["npm", "start"]
