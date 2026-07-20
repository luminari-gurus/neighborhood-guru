# Contributing to Neighborhood Guru 🏡

Thank you for your interest in contributing to **Neighborhood Guru**! We welcome bug fixes, UI/UX enhancements, new features, and documentation improvements.

---

## 🚀 Getting Started

1. **Fork the Repository**:
   Click the **Fork** button at the top right of the [neighborhood-guru](https://github.com/luminari-gurus/neighborhood-guru) repository.

2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/neighborhood-guru.git
   cd neighborhood-guru
   ```

3. **Install dependencies**:
   Per the workspace guidelines, **Bun** is the preferred package manager for installing packages and managing dependencies:
   ```bash
   bun install
   ```

4. **Start local development**:
   ```bash
   bun run dev
   ```

---

## 🌿 Branching Strategy & Conventions

Create a topic branch for your work:

- **Features**: `feat/description` (e.g. `feat/ev-charger-status`)
- **Bug fixes**: `fix/description` (e.g. `fix/popup-close-event`)
- **Documentation**: `docs/description` (e.g. `docs/update-readme`)

---

## 🎨 Design System & Code Style Guidelines

- **Vanilla Stack**: Use HTML5, Vanilla JavaScript (ES Modules), and Vanilla CSS. Do not add heavy utility frameworks like TailwindCSS unless explicitly discussed.
- **Glassmorphism Aesthetic**: Adhere to the app's dark-mode glassmorphism aesthetic (`glass-panel`, `btn-glass`, `backdrop-filter: blur(12px)`).
- **Responsive Layout**: Ensure UI additions function cleanly on both desktop and mobile viewports.
- **Icons**: Use clean inline SVG icons matching the Lucide icon design language.

---

## 🧪 Verification & Pre-Commit Checklist

Before opening a Pull Request, verify your changes compile cleanly without errors:

1. **Test Production Build**:
   ```bash
   bun run build
   ```
2. **Check Browser Console**: Ensure there are no JavaScript errors or unhandled promise rejections.
3. **Verify Local Privacy**: Confirm that no secrets, API keys, or personal PII are hardcoded into source files.

---

## 📥 Submitting a Pull Request (PR)

1. Push your topic branch to your fork:
   ```bash
   git push origin feat/your-feature-name
   ```
2. Open a Pull Request on the main `luminari-gurus/neighborhood-guru` repository.
3. Provide a clear summary of:
   - What changes were made.
   - Why the change is needed.
   - Screenshots or video recordings demonstrating UI changes (if applicable).

---

## 📄 License

By contributing to Neighborhood Guru, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
