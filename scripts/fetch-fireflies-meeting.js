#!/usr/bin/env node

/**
 * Fetch Specific Fireflies Meeting by ID
 *
 * This script fetches a single meeting transcript from Fireflies.ai
 * using its ID to debug why certain meetings aren't appearing in lists.
 *
 * Usage:
 *   node scripts/fetch-fireflies-meeting.js <meeting-id>
 *
 * Example:
 *   node scripts/fetch-fireflies-meeting.js 01K60P9JB9JCX6C5SPQG0ZXZK4
 */

const fs = require('fs');
const path = require('path');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Load environment variables
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      });
    }
  }
}

// Execute GraphQL query
async function graphqlRequest(apiKey, query, variables = {}) {
  const response = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`${colors.red}HTTP Error ${response.status}: ${response.statusText}${colors.reset}`);
    console.error(`Response: ${responseText}`);
    throw new Error(`Fireflies API error: ${response.status} ${response.statusText}`);
  }

  try {
    const data = JSON.parse(responseText);
    if (data.errors) {
      console.error(`${colors.red}GraphQL Errors:${colors.reset}`);
      console.error(JSON.stringify(data.errors, null, 2));
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  } catch (e) {
    console.error(`${colors.red}Failed to parse response:${colors.reset}`);
    console.error(responseText);
    throw e;
  }
}

// Fetch single transcript by ID
async function getTranscriptById(apiKey, id) {
  const query = `
    query GetTranscriptContent($id: String!) {
      transcript(id: $id) {
        id
        title
        transcript_url
        duration
        date
        participants
        sentences {
          text
          speaker_id
          start_time
        }
        summary {
          keywords
          action_items
          overview
          bullet_gist
          gist
          short_summary
          short_overview
          outline
          shorthand_bullet
          topics_discussed
          meeting_type
          transcript_chapters
        }
      }
    }
  `;

  const data = await graphqlRequest(apiKey, query, { id });
  return data.transcript;
}

// Also try to fetch using the list endpoint with date filters
async function getRecentTranscripts(apiKey, limit = 100) {
  const query = `
    query GetTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id
        title
        date
      }
    }
  `;

  const data = await graphqlRequest(apiKey, query, { limit });
  return data.transcripts || [];
}

// Format date
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Main function
async function main() {
  try {
    loadEnv();

    const apiKey = process.env.FIREFLIES_API_KEY;
    if (!apiKey) {
      console.error(`${colors.red}Error: FIREFLIES_API_KEY not found${colors.reset}`);
      process.exit(1);
    }

    const meetingId = process.argv[2];
    if (!meetingId) {
      console.log(`${colors.yellow}Usage: node scripts/fetch-fireflies-meeting.js <meeting-id>${colors.reset}`);
      console.log(`Example: node scripts/fetch-fireflies-meeting.js 01K60P9JB9JCX6C5SPQG0ZXZK4`);
      process.exit(1);
    }

    console.log(`${colors.cyan}Fetching meeting ${meetingId}...${colors.reset}\n`);

    // Try to fetch the specific meeting
    try {
      const transcript = await getTranscriptById(apiKey, meetingId);

      if (transcript) {
        console.log(`${colors.green}✓ Meeting Found${colors.reset}`);
        console.log(`${colors.bright}Title:${colors.reset} ${transcript.title}`);
        console.log(`${colors.bright}ID:${colors.reset} ${transcript.id}`);
        console.log(`${colors.bright}Date:${colors.reset} ${formatDate(transcript.date)}`);
        console.log(`${colors.bright}Duration:${colors.reset} ${Math.floor((transcript.duration || 0) / 60)} minutes`);
        console.log(`${colors.bright}Participants:${colors.reset} ${(transcript.participants || []).join(', ')}`);

        if (transcript.summary?.overview) {
          console.log(`\n${colors.bright}Summary:${colors.reset}`);
          console.log(transcript.summary.overview);
        }

        // Also check if this meeting appears in the list
        console.log(`\n${colors.cyan}Checking if meeting appears in recent list...${colors.reset}`);
        const recentList = await getRecentTranscripts(apiKey, 100);
        const foundInList = recentList.find(m => m.id === meetingId);

        if (foundInList) {
          console.log(`${colors.green}✓ Meeting IS in the recent transcripts list${colors.reset}`);
        } else {
          console.log(`${colors.yellow}⚠ Meeting is NOT in the recent transcripts list${colors.reset}`);
          console.log(`This could mean:`);
          console.log(`  - The meeting is older than the last 100 meetings`);
          console.log(`  - The meeting has different access permissions`);
          console.log(`  - The API key doesn't have access to this meeting`);

          // Show the date range of the list
          if (recentList.length > 0) {
            const dates = recentList.map(m => new Date(m.date)).sort((a, b) => b - a);
            console.log(`\n${colors.bright}Recent list date range:${colors.reset}`);
            console.log(`  Newest: ${formatDate(dates[0])}`);
            console.log(`  Oldest: ${formatDate(dates[dates.length - 1])}`);
            console.log(`  This meeting: ${formatDate(transcript.date)}`);
          }
        }

      } else {
        console.log(`${colors.red}✗ Meeting not found or no access${colors.reset}`);
      }
    } catch (error) {
      console.error(`${colors.red}Error fetching meeting:${colors.reset} ${error.message}`);

      // Try to see if we can at least list recent meetings
      console.log(`\n${colors.cyan}Attempting to list recent meetings...${colors.reset}`);
      try {
        const recentList = await getRecentTranscripts(apiKey, 10);
        if (recentList.length > 0) {
          console.log(`${colors.green}API key is valid. Found ${recentList.length} recent meetings:${colors.reset}`);
          recentList.forEach((m, i) => {
            console.log(`  ${i + 1}. ${m.title} (${m.id})`);
          });
        }
      } catch (listError) {
        console.error(`${colors.red}Could not list meetings either. Check your API key permissions.${colors.reset}`);
      }
    }

  } catch (error) {
    console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    if (error.stack && process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}