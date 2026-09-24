const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/*
  For a production setup, replace this in-memory simulation with a persistent store:
  1. Redis/Upstash: Increment/decrement keys for active sessions with expiry.
  2. Netlify Blobs: Store JSON object with active sessions and timestamps.
  3. Firebase Realtime Database: Presence system.
*/

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const now = new Date();
    const hours = now.getUTCHours(); // Assuming UTC, adjust as needed

    // Base count varies by time of day (e.g., peak at 18:00 - 22:00)
    let baseCount = 50;
    if (hours >= 18 && hours <= 22) baseCount = 150;
    else if (hours >= 12 && hours < 18) baseCount = 100;
    else if (hours >= 0 && hours < 6) baseCount = 45;

    // Add randomness for realism (±10-30 listeners)
    // Seeded randomness based on hour and minute
    const minutes = now.getUTCMinutes();
    const randomOffset = Math.floor(Math.sin(hours * 60 + minutes) * 20); 
    
    let count = Math.max(45, baseCount + randomOffset);
    
    // Simulate trend
    let trend = 'stable';
    if (randomOffset > 10) trend = 'up';
    else if (randomOffset < -10) trend = 'down';

    // Simulate peak
    const peak = Math.max(count + 25, 180);

    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ count, peak, trend })
      };
    }

    if (event.httpMethod === 'POST') {
      // In a real app, process join/leave with a session store here
      // const body = JSON.parse(event.body);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, count, peak, trend })
      };
    }

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error' })
    };
  }
};
