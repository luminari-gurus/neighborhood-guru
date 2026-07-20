/* ==========================================================================
   OVERPASS SERVICE - OPENSTREETMAP LOCAL POI DISCOVERY (FREE, NO KEY)
   ========================================================================== */

export class OverpassService {
  /**
   * Fetch nearby public points of interest using OpenStreetMap Overpass API
   */
  static async fetchNearbyPois(lat, lng, radiusMeters = 1200) {
    try {
      // Query OpenStreetMap nodes for cafes, parks, libraries, EV chargers, and bakeries
      const query = `
        [out:json][timeout:15];
        (
          node["amenity"~"cafe|library|charging_station|post_office"](around:${radiusMeters},${lat},${lng});
          node["leisure"~"park|playground"](around:${radiusMeters},${lat},${lng});
          way["leisure"~"park|playground"](around:${radiusMeters},${lat},${lng});
          node["shop"~"bakery|supermarket|convenience"](around:${radiusMeters},${lat},${lng});
        );
        out center 35;
      `;

      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (!response.ok) throw new Error('Overpass API query failed');

      const data = await response.json();
      if (!data.elements) return [];

      return data.elements
        .filter(el => el.tags && (el.tags.name || el.tags['amenity'] || el.tags['leisure'] || el.tags['shop']))
        .map(el => {
          const tags = el.tags || {};
          const elLat = el.lat || (el.center ? el.center.lat : lat);
          const elLng = el.lon || (el.center ? el.center.lon : lng);

          let category = 'favorite';
          let color = '#3b82f6';
          let typeLabel = 'Local Spot';

          if (tags.amenity === 'cafe' || tags.shop === 'bakery') {
            category = 'favorite';
            color = '#f59e0b';
            typeLabel = 'Cafe & Bakery';
          } else if (tags.leisure === 'park' || tags.leisure === 'playground') {
            category = 'favorite';
            color = '#10b981';
            typeLabel = 'Park & Recreation';
          } else if (tags.amenity === 'library' || tags.amenity === 'school') {
            category = 'service';
            color = '#8b5cf6';
            typeLabel = 'Library & School';
          } else if (tags.amenity === 'charging_station') {
            category = 'service';
            color = '#06b6d4';
            typeLabel = 'EV Charging Station';
          } else if (tags.shop === 'supermarket' || tags.shop === 'convenience') {
            category = 'favorite';
            color = '#ec4899';
            typeLabel = 'Grocery & Market';
          }

          const street = tags['addr:street'] ? `${tags['addr:housenumber'] || ''} ${tags['addr:street']}`.trim() : '';

          return {
            osmId: el.id,
            name: tags.name || `${typeLabel} (${elLat.toFixed(3)}, ${elLng.toFixed(3)})`,
            category: category,
            typeLabel: typeLabel,
            address: street || tags['addr:city'] || '',
            lat: elLat,
            lng: elLng,
            color: color,
            notes: `Discovered via OpenStreetMap. ${tags.website ? `Website: ${tags.website}` : ''} ${tags.opening_hours ? `Hours: ${tags.opening_hours}` : ''}`.trim(),
          };
        });
    } catch (err) {
      console.warn('Overpass Service Error:', err);
      return [];
    }
  }
}
