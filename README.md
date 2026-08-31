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

3. **API Key Configuration**:

   > **🔑 Mapbox Access Token (REQUIRED)**  
   > A Mapbox Access Token (`pk.eyJ1...`) is **required** to render 3D Earth Globe navigation, satellite imagery, 3D building elevation, and street address geocoding.  
   > You can get a free Mapbox token at [mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/).

   > **🎸 JamBase API Key (OPTIONAL)**  
   > A JamBase API Key (`jbd_live_...`) is **optional**. If omitted, Neighborhood Guru automatically uses its built-in web microdata scraper, so venue concert listings work out-of-the-box. Providing an optional JamBase Data API v3 key enables instant 50ms direct API responses.

   **Setting up keys:**
   
   Option A: Configure via `.env` file:
   ```bash
   cp .env.example .env
   ```
   ```env
   # REQUIRED: Mapbox token for 3D map rendering & geocoding
   VITE_MAPBOX_TOKEN=pk.eyJ1IjoieW91ci11c2VybmFtZSIsImEiOiJjbHB6Y2V4Yzgx...

   # OPTIONAL: JamBase Data API v3 key for fast concert loading
   VITE_JAMBASE_TOKEN=jbd_live_your_key_here
   ```

   Option B: Configure directly inside the app:
   You can also enter your keys at any time via the **⚙️ Settings** (or first-launch prompt) modal inside the app. Keys are stored 100% locally in your browser (`localStorage`).

4. **Start the local development server**:
   ```bash
   bun run dev
   ```
   Open `http://localhost:5173` in your browser.

5. **Build for production**:
   ```bash
   bun run build
   ```

### Optional authentication backend

The static, local-first build remains the default: its injected runtime mode is `disabled`, it constructs the anonymous AuthClient, and it makes zero authentication requests. `bun run server` serves `dist/` and `/api/auth` on one origin.

Set `AUTH_MODE=optional` to serve the app anonymously with auth available.
Set `AUTH_MODE=required` to serve a generic login bootstrap on `/` and block all protected SPA/static/API content (`401 authentication_required`) until a session is established. Required mode still allows `/api/auth/providers` discovery for bootstrap rendering.
`createServer({ mode: 'required', providerRegistry })` refuses to start with no adapters so there is always a valid login path at runtime.

**Local development with auth enabled** uses Vite on port 5173 and the Bun server on port 3000:

```bash
cp .env.example .env
```

Set these **server-only** values in `.env` (do not prefix them with `VITE_`; they must never reach the browser):

```env
AUTH_MODE=optional
AUTH_DATABASE_PATH=./neighborhood-guru.sqlite
AUTH_SECRET=replace-with-at-least-32-random-characters
```

`AUTH_DATABASE_PATH` is required whenever `AUTH_MODE` is `optional` or `required`, in every environment, so sessions persist across restarts. `:memory:` is used only when you set `AUTH_DATABASE_PATH=:memory:` explicitly (for tests).

Then run the API server and Vite together (separate terminals):

```bash
bun run server
bun run dev
```

Vite proxies `/api/auth` to `AUTH_DEV_SERVER` (default `http://localhost:3000`) and, when `AUTH_MODE` is `optional` or `required`, replaces the static runtime marker (`globalThis.__NG_RUNTIME_CONFIG__={authMode:"disabled"};`) with JSON `{ authMode }` so the HTTP AuthClient is enabled. Without those modes, `bun run dev` keeps the static disabled default.

The production server injects only `{ authMode }` into the built HTML. Database paths, `AUTH_SECRET`, provider credentials, and deployment-specific values are never browser configuration.

Enabled authentication always requires an `AUTH_SECRET` of at least 32 characters. It keys purpose-separated HMAC-SHA-256 hashes for session tokens, login state, and CSRF material. Changing it deliberately invalidates all outstanding login transactions and sessions; stale session cookies are actively cleared when users start a new login under the rotated secret so recovery is usually a single click, while callbacks remain fail-closed when stale cookies are still attached.

The provider-neutral API exposes discovery, session, login/callback, and CSRF-protected logout under `/api/auth`. No concrete identity provider is bundled. Adapters implement `createAuthorizationUrl` and `exchangeCallback`; provider context is optional, typed JSON-safe, and bounded.
In `required` mode, the provider list and callback bootstrap live in separate runtime composition layers (`createServer({ providerRegistry })` plus `createAuthBackend`) and are used by the generic required-mode UI.
Login state is stored as a server-owned keyed hash, bound to provider and return path, expires, and is claimed/consumed before provider callback exchange. On adapter failure, exchange failure, or final DB conflict, consumed state remains consumed; users restart from a new login flow.
Authentication data consists of user profiles, identities uniquely keyed by `(issuer, subject)`, and opaque HMAC-bound sessions.

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
