const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const tracks = [
  { title: "Last Last", artist: "Burna Boy", album: "Love, Damini", duration: 172 },
  { title: "Essence", artist: "Wizkid, Tems", album: "Made In Lagos", duration: 248 },
  { title: "Soweto", artist: "Victony, Tempoe", album: "Outlaw", duration: 147 },
  { title: "Calm Down", artist: "Rema", album: "Rave & Roses", duration: 239 },
  { title: "Rush", artist: "Ayra Starr", album: "19 & Dangerous", duration: 185 },
  { title: "Amapiano", artist: "Asake, Olamide", album: "Work Of Art", duration: 167 },
  { title: "Rich Flex", artist: "Drake, 21 Savage", album: "Her Loss", duration: 239 },
  { title: "N95", artist: "Kendrick Lamar", album: "Mr. Morale & The Big Steppers", duration: 195 },
  { title: "CUFF IT", artist: "Beyoncé", album: "RENAISSANCE", duration: 225 },
  { title: "Unavailable", artist: "Davido, Musa Keys", album: "Timeless", duration: 170 },
  { title: "Kwaku the Traveller", artist: "Black Sherif", album: "The Villain I Never Was", duration: 185 },
  { title: "Non Living Thing", artist: "Sarkodie, Oxlade", album: "No Pressure", duration: 226 },
  { title: "Into the Future", artist: "Stonebwoy", album: "5th Dimension", duration: 196 },
  { title: "My Level", artist: "Shatta Wale", album: "Wonder Boy", duration: 181 },
  { title: "SAD GIRLZ LUV MONEY", artist: "Amaarae, Kali Uchis", album: "The Angel You Don't Know", duration: 204 },
  { title: "Finesse", artist: "Pheelz, BNXN", album: "Finesse", duration: 154 },
  { title: "Sinner", artist: "Adekunle Gold", album: "Catch Me If You Can", duration: 176 },
  { title: "Buga", artist: "Kizz Daniel, Tekno", album: "Maverick", duration: 184 },
  { title: "Dior", artist: "Ruger", album: "The Second Wave", duration: 194 },
  { title: "Peru", artist: "Fireboy DML", album: "Playboy", duration: 187 }
];

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
    const now = new Date();
    // Rotate every 3 minutes (180000 ms)
    const seed = Math.floor(now.getTime() / 180000);
    const index = seed % tracks.length;
    const track = tracks[index];
    
    // Calculate startedAt
    const cycleStart = new Date(seed * 180000);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: `https://picsum.photos/seed/${encodeURIComponent(track.title)}/300/300`,
        startedAt: cycleStart.toISOString(),
        duration: track.duration
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error' })
    };
  }
};
