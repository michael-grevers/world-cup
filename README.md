# World Cup Fantasy 2026

## Requirements

- Node.js 18 or newer

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and add your API key:

```
FOOTBALL_DATA_API_KEY=...   # https://www.football-data.org/client/register
PORT=3000                   # optional, defaults to 3000
```

Player goals are fetched from [OpenFootball](https://github.com/openfootball/worldcup.json) (no API key required).

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Development

```bash
npm run dev
```

Uses `nodemon` to restart the server when files change.
