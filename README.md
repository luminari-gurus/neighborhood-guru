# Neighborhood Guru 🏡📍

> **Your Interactive Neighborhood Hub & Local Directory**  
> Explore your neighborhood with 3D Earth globe navigation, manage local contact information, track recurring events, discover nearby points of interest, and stay connected with live concert schedules at local music venues.

![Neighborhood Guru](https://raw.githubusercontent.com/luminari-gurus/neighborhood-guru/main/dist/assets/favicon.ico)

---

## ✨ Features

- 🌍 **3D Earth Globe & Satellite Imaging**: Seamlessly zoom between 3D space globe view and high-definition street satellite imagery powered by **Mapbox GL JS v3**.
- ☀️ **Real-Time 3D Solar & Building Shadows**: Interactive solar position controller that simulates real-time building shadows and sun trajectories across the day.
- 📍 **Local Contacts & People Management**: Store neighborhood locations, households, trade services, and favorite spots with custom marker colors and contact info.
- 📅 **Recurring Schedules & Events**: Track weekly recurring events (e.g. Friday Farmer's Markets, daily coffee meetups) with automatic **"Happening Today"** highlighting.
- 🎭 **JamBase Venue Integration & Live Concerts**:
  - Direct integration with **JamBase Data API v3** and live venue microdata.
  - Asynchronously loads upcoming concerts, doors times, dates, performer lineups, and direct ticket links right inside map popups and sidebar location cards.
  - **Venue Max Capacity** tracking (`👥 Max Capacity: 1,200 people`).
  - Persistent **24-Hour Local Caching** with manual `🔄` refresh.
- 🔍 **OpenStreetMap POI Discovery**: Automatically scan nearby cafes, parks, libraries, and EV charging stations via the **Overpass API** and import them with one click.
- 🌤️ **Live Weather Forecasts**: Integrated hyper-local weather conditions powered by **Open-Meteo**.
- 🔒 **100% Private & Local-First**: All location data, contact numbers, notes, and API keys are stored strictly in your browser (`localStorage`). No user data is sent to external application servers.
- 📁 **JSON Data Export & Import**: Backup and restore your complete neighborhood directory at any time.

---

## 🛠️ Technology Stack

- **Core**: HTML5, Vanilla JavaScript (ES Modules), Vanilla CSS
- **Styling**: Modern CSS Design System (Glassmorphism, dark mode, dynamic animations)
- **Mapping & Geocoding**: [Mapbox GL JS v3](https://www.mapbox.com/mapbox-gl-js)
- **Music & Events**: [JamBase Data API v3](https://www.jambase.com)
- **POI Data**: OpenStreetMap [Overpass API](https://overpass-api.de)
- **Weather**: [Open-Meteo API](https://open-meteo.com)
- **Build Tool & Runtime**: [Vite](https://vitejs.dev) + [Bun](https://bun.sh)

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh) (preferred package manager) or [Node.js](https://nodejs.org) (v18+)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/luminari-gurus/neighborhood-guru.git
   cd neighborhood-guru
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Configure Environment Variables** (Optional):
   Create a `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```
   Add your keys:
   ```env
   VITE_MAPBOX_TOKEN=pk.eyJ1...
   VITE_JAMBASE_TOKEN=jbd_live_...
   ```
   > *Note: API keys can also be provided directly inside the app's **⚙️ Settings** modal and are saved to browser `localStorage`.*

4. **Start the local development server**:
   ```bash
   bun run dev
   ```
   Open `http://localhost:5173` in your browser.

5. **Build for production**:
   ```bash
   bun run build
   ```

---

## 📂 Project Structure

```
neighborhood-guru/
├── index.html              # Main HTML application markup & modals
├── vite.config.js          # Vite build & proxy configuration
├── requests.http           # Sample HTTP REST requests for JamBase API testing
├── src/
│   ├── style.css           # Glassmorphism design system & utility classes
│   ├── main.js             # Main application orchestrator & event handlers
│   └── js/
│       ├── jambase-service.js  # JamBase venue search & live concert scraper/API
│       ├── mapbox-service.js   # 3D Mapbox GL map initialization & markers
│       ├── overpass-service.js # OpenStreetMap POI discovery via Overpass API
│       ├── storage.js          # LocalStorage persistence & data migration
│       ├── ui.js               # UI controller, drawer, modals, & toast notices
│       └── weather.js          # Open-Meteo weather integration
├── package.json
└── README.md
```

---

## 🛡️ Security & Privacy Notice

Neighborhood Guru is built with a **Local-First** privacy architecture:
- Your saved neighborhood contacts, phone numbers, notes, and addresses remain on your device in browser `localStorage`.
- API tokens (Mapbox and JamBase) are stored locally in your browser and used strictly for direct client API calls.

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on branch naming, code style, and submitting Pull Requests.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
