const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-cache, no-store'
};

const RELAY_STATUS_URL = process.env.RELAY_STATUS_URL || 'https://wave-radio-relay.onrender.com/status';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // Check if live DJ broadcast is active on the relay server
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    let liveData = null;
    try {
      const response = await fetch(RELAY_STATUS_URL, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (response.ok) {
        liveData = await response.json();
      }
    } catch (_) {
      // Relay server might be offline or sleeping
    } finally {
      clearTimeout(timeout);
    }

    if (liveData && liveData.isLive) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          isLive: true,
          title: liveData.trackTitle || liveData.showTitle || 'Live DJ Show',
          artist: liveData.trackArtist ? `${liveData.trackArtist} (Live with ${liveData.djName || 'DJ'})` : `Live with ${liveData.djName || 'DJ'}`,
          djName: liveData.djName || 'DJ',
          showTitle: liveData.showTitle || 'Live Show',
          startedAt: liveData.startedAt || new Date().toISOString(),
          listeners: liveData.listeners || 0
        })
      };
    }

    // Default off-air state - all fake default tracks removed
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        isLive: false,
        title: 'Bethel Radio',
        artist: 'Station Library / Ready for Broadcast',
        startedAt: new Date().toISOString()
      })
    };
  } catch (error) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        isLive: false,
        title: 'Bethel Radio',
        artist: 'Feel The Frequency',
        startedAt: new Date().toISOString()
      })
    };
  }
};
