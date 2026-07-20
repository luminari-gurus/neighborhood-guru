/* ==========================================================================
   WEATHER SERVICE - OPEN-METEO LIVE HYPER-LOCAL FORECAST (FREE API, NO KEY)
   ========================================================================== */

const WMO_WEATHER_CODES = {
  0: { desc: 'Clear Sky', icon: '☀️' },
  1: { desc: 'Mainly Clear', icon: '🌤️' },
  2: { desc: 'Partly Cloudy', icon: '⛅' },
  3: { desc: 'Overcast', icon: '☁️' },
  45: { desc: 'Foggy', icon: '🌫️' },
  48: { desc: 'Icy Fog', icon: '🌫️' },
  51: { desc: 'Light Drizzle', icon: '🌦️' },
  53: { desc: 'Drizzle', icon: '🌧️' },
  55: { desc: 'Heavy Drizzle', icon: '🌧️' },
  61: { desc: 'Slight Rain', icon: '🌧️' },
  63: { desc: 'Rain', icon: '🌧️' },
  65: { desc: 'Heavy Rain', icon: '🌧️' },
  71: { desc: 'Light Snow', icon: '🌨️' },
  73: { desc: 'Snow', icon: '❄️' },
  75: { desc: 'Heavy Snow', icon: '❄️' },
  80: { desc: 'Rain Showers', icon: '🌦️' },
  81: { desc: 'Heavy Showers', icon: '🌧️' },
  95: { desc: 'Thunderstorm', icon: '⚡' },
};

export class WeatherService {
  /**
   * Fetch current weather from Open-Meteo API
   */
  static async getWeather(lat, lng) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&temperature_unit=fahrenheit`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Weather API request failed');

      const data = await res.json();
      const current = data.current_weather;

      if (!current) throw new Error('Invalid weather payload');

      const code = current.weathercode;
      const info = WMO_WEATHER_CODES[code] || { desc: 'Fair', icon: '🌤️' };

      return {
        temp: Math.round(current.temperature),
        tempUnit: '°F',
        windSpeed: Math.round(current.windspeed),
        code: code,
        desc: info.desc,
        icon: info.icon,
      };
    } catch (err) {
      console.warn('Weather Service Error:', err);
      return null;
    }
  }
}
