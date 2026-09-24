const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=300'
};

const schedule = [
  // Sunday
  { id: 'sun1', title: 'Sunday Gospel Morning', dj: 'DJ Praise', genre: 'Gospel', day: 0, startTime: '06:00', endTime: '10:00', description: 'Uplifting gospel tunes to start your Sunday.', image: 'https://picsum.photos/seed/sun1/300/200' },
  { id: 'sun2', title: 'Jazz Brunch', dj: 'Smooth Operator', genre: 'Jazz', day: 0, startTime: '10:00', endTime: '14:00', description: 'Smooth jazz for your relaxing Sunday.', image: 'https://picsum.photos/seed/sun2/300/200' },
  { id: 'sun3', title: 'Afrobeats Top 40', dj: 'DJ K-Z', genre: 'Afrobeats', day: 0, startTime: '14:00', endTime: '18:00', description: 'The hottest Afrobeats tracks of the week.', image: 'https://picsum.photos/seed/sun3/300/200' },
  { id: 'sun4', title: 'Throwback Sunday', dj: 'Old School Kenny', genre: 'Throwback/Oldies', day: 0, startTime: '18:00', endTime: '22:00', description: 'Classic hits from the 90s and 2000s.', image: 'https://picsum.photos/seed/sun4/300/200' },
  { id: 'sun5', title: 'Night Vibe', dj: 'DJ Sleepy', genre: 'R&B', day: 0, startTime: '22:00', endTime: '06:00', description: 'Slow jams for the late night.', image: 'https://picsum.photos/seed/sun5/300/200' },

  // Monday
  { id: 'mon1', title: 'Morning Drive', dj: 'DJ Flex', genre: 'Hip-Hop', day: 1, startTime: '06:00', endTime: '10:00', description: 'Wake up with energy!', image: 'https://picsum.photos/seed/mon1/300/200' },
  { id: 'mon2', title: 'Midday Motivation', dj: 'MC Talk', genre: 'Talk Show', day: 1, startTime: '10:00', endTime: '14:00', description: 'Discussions and interviews on current trends.', image: 'https://picsum.photos/seed/mon2/300/200' },
  { id: 'mon3', title: 'Afternoon Bounce', dj: 'DJ Spin', genre: 'Afrobeats', day: 1, startTime: '14:00', endTime: '18:00', description: 'Keep the day moving with the latest hits.', image: 'https://picsum.photos/seed/mon3/300/200' },
  { id: 'mon4', title: 'Electronic Sunset', dj: 'Synth Master', genre: 'Electronic', day: 1, startTime: '18:00', endTime: '22:00', description: 'EDM and house music.', image: 'https://picsum.photos/seed/mon4/300/200' },
  { id: 'mon5', title: 'Late Night Chill', dj: 'DJ Vibe', genre: 'R&B', day: 1, startTime: '22:00', endTime: '06:00', description: 'Relaxing tunes.', image: 'https://picsum.photos/seed/mon5/300/200' },

  // Tuesday
  { id: 'tue1', title: 'Morning Drive', dj: 'DJ Flex', genre: 'Hip-Hop', day: 2, startTime: '06:00', endTime: '10:00', description: 'Wake up with energy!', image: 'https://picsum.photos/seed/tue1/300/200' },
  { id: 'tue2', title: 'Workday Flow', dj: 'Smooth Operator', genre: 'R&B', day: 2, startTime: '10:00', endTime: '14:00', description: 'Background hits for your office.', image: 'https://picsum.photos/seed/tue2/300/200' },
  { id: 'tue3', title: 'Afrobeats Heat', dj: 'DJ K-Z', genre: 'Afrobeats', day: 2, startTime: '14:00', endTime: '18:00', description: 'Unstoppable Afrobeats.', image: 'https://picsum.photos/seed/tue3/300/200' },
  { id: 'tue4', title: 'Reggae Roots', dj: 'Jah Man', genre: 'Reggae/Dancehall', day: 2, startTime: '18:00', endTime: '22:00', description: 'Caribbean vibes.', image: 'https://picsum.photos/seed/tue4/300/200' },
  { id: 'tue5', title: 'Late Night Chill', dj: 'DJ Vibe', genre: 'R&B', day: 2, startTime: '22:00', endTime: '06:00', description: 'Relaxing tunes.', image: 'https://picsum.photos/seed/tue5/300/200' },

  // Wednesday
  { id: 'wed1', title: 'Morning Drive', dj: 'DJ Flex', genre: 'Hip-Hop', day: 3, startTime: '06:00', endTime: '10:00', description: 'Wake up with energy!', image: 'https://picsum.photos/seed/wed1/300/200' },
  { id: 'wed2', title: 'Mid-Week Talk', dj: 'MC Talk', genre: 'Talk Show', day: 3, startTime: '10:00', endTime: '14:00', description: 'Deep dives into pop culture.', image: 'https://picsum.photos/seed/wed2/300/200' },
  { id: 'wed3', title: 'Afrobeats Bounce', dj: 'DJ Spin', genre: 'Afrobeats', day: 3, startTime: '14:00', endTime: '18:00', description: 'Afternoon party.', image: 'https://picsum.photos/seed/wed3/300/200' },
  { id: 'wed4', title: 'Hip Hop History', dj: 'DJ Scratch', genre: 'Throwback/Oldies', day: 3, startTime: '18:00', endTime: '22:00', description: 'Golden era hip hop.', image: 'https://picsum.photos/seed/wed4/300/200' },
  { id: 'wed5', title: 'Late Night Chill', dj: 'DJ Vibe', genre: 'R&B', day: 3, startTime: '22:00', endTime: '06:00', description: 'Relaxing tunes.', image: 'https://picsum.photos/seed/wed5/300/200' },

  // Thursday
  { id: 'thu1', title: 'Morning Drive', dj: 'DJ Flex', genre: 'Hip-Hop', day: 4, startTime: '06:00', endTime: '10:00', description: 'Wake up with energy!', image: 'https://picsum.photos/seed/thu1/300/200' },
  { id: 'thu2', title: 'Jazz Café', dj: 'Smooth Operator', genre: 'Jazz', day: 4, startTime: '10:00', endTime: '14:00', description: 'Modern and classic jazz.', image: 'https://picsum.photos/seed/thu2/300/200' },
  { id: 'thu3', title: 'Afrobeats Heat', dj: 'DJ K-Z', genre: 'Afrobeats', day: 4, startTime: '14:00', endTime: '18:00', description: 'Unstoppable Afrobeats.', image: 'https://picsum.photos/seed/thu3/300/200' },
  { id: 'thu4', title: 'Dancehall Clash', dj: 'Jah Man', genre: 'Reggae/Dancehall', day: 4, startTime: '18:00', endTime: '22:00', description: 'Dancehall anthems.', image: 'https://picsum.photos/seed/thu4/300/200' },
  { id: 'thu5', title: 'Late Night Chill', dj: 'DJ Vibe', genre: 'R&B', day: 4, startTime: '22:00', endTime: '06:00', description: 'Relaxing tunes.', image: 'https://picsum.photos/seed/thu5/300/200' },

  // Friday
  { id: 'fri1', title: 'TGIF Morning', dj: 'DJ Flex', genre: 'Hip-Hop', day: 5, startTime: '06:00', endTime: '10:00', description: 'Start the weekend right.', image: 'https://picsum.photos/seed/fri1/300/200' },
  { id: 'fri2', title: 'Feel Good Friday', dj: 'MC Talk', genre: 'Talk Show', day: 5, startTime: '10:00', endTime: '14:00', description: 'Fun topics and listener calls.', image: 'https://picsum.photos/seed/fri2/300/200' },
  { id: 'fri3', title: 'Pre-Party Mix', dj: 'DJ Spin', genre: 'Afrobeats', day: 5, startTime: '14:00', endTime: '18:00', description: 'Getting ready for the night.', image: 'https://picsum.photos/seed/fri3/300/200' },
  { id: 'fri4', title: 'Friday Night Live', dj: 'DJ K-Z', genre: 'Afrobeats', day: 5, startTime: '18:00', endTime: '22:00', description: 'The biggest party on radio.', image: 'https://picsum.photos/seed/fri4/300/200' },
  { id: 'fri5', title: 'Afterhours Club', dj: 'Synth Master', genre: 'Electronic', day: 5, startTime: '22:00', endTime: '06:00', description: 'Non-stop EDM mixes.', image: 'https://picsum.photos/seed/fri5/300/200' },

  // Saturday
  { id: 'sat1', title: 'Weekend Wake Up', dj: 'DJ Flex', genre: 'Hip-Hop', day: 6, startTime: '06:00', endTime: '10:00', description: 'High energy hip hop.', image: 'https://picsum.photos/seed/sat1/300/200' },
  { id: 'sat2', title: 'Global Grooves', dj: 'DJ World', genre: 'Afrobeats', day: 6, startTime: '10:00', endTime: '14:00', description: 'Music from around the world.', image: 'https://picsum.photos/seed/sat2/300/200' },
  { id: 'sat3', title: 'Saturday Jam', dj: 'DJ Spin', genre: 'R&B', day: 6, startTime: '14:00', endTime: '18:00', description: 'Smooth R&B hits.', image: 'https://picsum.photos/seed/sat3/300/200' },
  { id: 'sat4', title: 'The Main Event', dj: 'DJ Scratch', genre: 'Hip-Hop', day: 6, startTime: '18:00', endTime: '22:00', description: 'Saturday night hip hop takeover.', image: 'https://picsum.photos/seed/sat4/300/200' },
  { id: 'sat5', title: 'Afterhours Club', dj: 'Synth Master', genre: 'Electronic', day: 6, startTime: '22:00', endTime: '06:00', description: 'Non-stop EDM mixes.', image: 'https://picsum.photos/seed/sat5/300/200' }
];

const checkIsLive = (show, now) => {
  const currentDay = now.getDay();
  if (currentDay !== show.day) return false;

  const [startHour, startMin] = show.startTime.split(':').map(Number);
  const [endHour, endMin] = show.endTime.split(':').map(Number);

  const startMs = startHour * 60 * 60 * 1000 + startMin * 60 * 1000;
  let endMs = endHour * 60 * 60 * 1000 + endMin * 60 * 1000;
  
  if (endHour < startHour) {
    // Crosses midnight
    endMs += 24 * 60 * 60 * 1000;
  }

  const currentMs = now.getHours() * 60 * 60 * 1000 + now.getMinutes() * 60 * 1000 + now.getSeconds() * 1000;

  // Handle cross midnight for current time comparison
  if (endHour < startHour && currentMs < endMs - 24 * 60 * 60 * 1000) {
     return true; // it is past midnight, but before end time
  }
  
  if (endHour < startHour && currentMs > startMs) {
      return true; // it is before midnight, past start time
  }

  return currentMs >= startMs && currentMs < endMs;
};

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
    
    const enrichedSchedule = schedule.map(show => ({
      ...show,
      isLive: checkIsLive(show, now)
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(enrichedSchedule)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error' })
    };
  }
};
