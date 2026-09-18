export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).setHeader('cache-control', 'no-store').end('Method not allowed');
    return;
  }

  const parts = req.query.path;
  const path = Array.isArray(parts) ? parts.join('/') : String(parts || '');
  if (!path || path.includes('..') || path.includes('\\') || path.includes('\0')) {
    res.status(404).end('Not found');
    return;
  }

  const searchIndex = req.url.indexOf('?');
  const search = searchIndex >= 0 ? req.url.slice(searchIndex) : '';
  const target = `https://api.data.jambase.com/v3/${path}${search}`;

  try {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'NeighborhoodGuru/1.0 (+https://github.com/luminari-gurus/neighborhood-guru)',
    };
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    const upstream = await fetch(target, { method: req.method, headers });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.send(body);
  } catch {
    res.status(502);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.send(JSON.stringify({ error: 'jambase_upstream_unreachable' }));
  }
}
