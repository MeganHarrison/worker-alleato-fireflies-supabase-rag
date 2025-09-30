#!/usr/bin/env node

/**
 * List Recent Fireflies Meetings
 *
 * This script fetches and displays recent meeting transcripts from Fireflies.ai
 * using their GraphQL API. It shows meeting metadata including title, date,
 * duration, participants, and summary information.
 *
 * Usage:
 *   node scripts/list-fireflies-meetings.js [options]
 *
 * Options:
 *   --limit <number>    Number of meetings to fetch (default: 10, max: 100)
 *   --days <number>     Fetch meetings from last N days (optional)
 *   --detailed          Show detailed information including action items
 *   --json              Output as JSON instead of formatted text
 *
 * Environment:
 *   Requires FIREFLIES_API_KEY environment variable or in .env.local file
 */

const fs = require('fs');
const path = require('path');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

// Load environment variables from .env.local or parent .env if they exist
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

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    limit: 10,
    days: null,
    detailed: false,
    json: false,
    titles: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        options.limit = Math.min(100, parseInt(args[++i]) || 10);
        break;
      case '--days':
        options.days = parseInt(args[++i]);
        break;
      case '--detailed':
        options.detailed = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--titles':
        options.titles = true;
        break;
      case '--help':
        console.log(`
${colors.bright}List Recent Fireflies Meetings${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node scripts/list-fireflies-meetings.js [options]

${colors.cyan}Options:${colors.reset}
  --limit <number>    Number of meetings to fetch (default: 10, max: 100)
  --days <number>     Fetch meetings from last N days (optional)
  --detailed          Show detailed information including action items
  --titles            Show only meeting titles in a simple list
  --json              Output as JSON instead of formatted text
  --help              Show this help message

${colors.cyan}Examples:${colors.reset}
  node scripts/list-fireflies-meetings.js --limit 5
  node scripts/list-fireflies-meetings.js --days 7 --detailed
  node scripts/list-fireflies-meetings.js --days 7 --titles
  node scripts/list-fireflies-meetings.js --json > meetings.json
        `);
        process.exit(0);
    }
  }

  return options;
}

// Execute GraphQL query against Fireflies API
async function graphqlRequest(apiKey, query, variables = {}) {
  const response = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Fireflies API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
  }

  return data.data;
}

// Fetch list of recent transcripts
async function getTranscripts(apiKey, limit = 10, toDate = null, fromDate = null) {
  // First try the standard query
  const query = `
    query GetTranscripts($limit: Int, $toDate: DateTime, $fromDate: DateTime) {
      transcripts(limit: $limit, toDate: $toDate, fromDate: $fromDate) {
        id
        title
        transcript_url
        duration
        date
        participants
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

  const variables = { limit };
  if (toDate) {
    variables.toDate = toDate;
  }
  if (fromDate) {
    variables.fromDate = fromDate;
  }

  try {
    const data = await graphqlRequest(apiKey, query, variables);
    return data.transcripts || [];
  } catch (error) {
    // If fromDate parameter fails, try without it
    if (fromDate) {
      console.log(`Note: fromDate parameter not supported, fetching without date filter`);
      delete variables.fromDate;
      const data = await graphqlRequest(apiKey, query, variables);
      return data.transcripts || [];
    }
    throw error;
  }
}

// Format duration from seconds to human readable
function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes} minutes`;
}

// Format date to local string
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

// Display meeting in formatted text
function displayMeeting(meeting, index, detailed = false) {
  console.log(`\n${colors.bright}${colors.cyan}[${index + 1}]${colors.reset} ${colors.bright}${meeting.title}${colors.reset}`);
  console.log(`${colors.dim}${'─'.repeat(60)}${colors.reset}`);
  console.log(`${colors.yellow}📅 Date:${colors.reset} ${formatDate(meeting.date)}`);
  console.log(`${colors.yellow}⏱  Duration:${colors.reset} ${formatDuration(meeting.duration)}`);
  console.log(`${colors.yellow}👥 Participants:${colors.reset} ${(meeting.participants || []).join(', ') || 'None listed'}`);
  console.log(`${colors.yellow}🆔 ID:${colors.reset} ${meeting.id}`);

  if (meeting.transcript_url) {
    console.log(`${colors.yellow}🔗 URL:${colors.reset} ${meeting.transcript_url}`);
  }

  if (meeting.summary) {
    if (meeting.summary.meeting_type) {
      console.log(`${colors.yellow}📝 Type:${colors.reset} ${meeting.summary.meeting_type}`);
    }

    if (meeting.summary.overview || meeting.summary.short_overview) {
      const overview = meeting.summary.overview || meeting.summary.short_overview;
      console.log(`\n${colors.green}Summary:${colors.reset}`);
      console.log(`  ${overview.substring(0, 200)}${overview.length > 200 ? '...' : ''}`);
    }

    if (detailed) {
      if (meeting.summary.keywords && meeting.summary.keywords.length > 0) {
        console.log(`\n${colors.magenta}Keywords:${colors.reset}`);
        console.log(`  ${meeting.summary.keywords.slice(0, 10).join(', ')}`);
      }

      if (meeting.summary.topics_discussed && meeting.summary.topics_discussed.length > 0) {
        console.log(`\n${colors.magenta}Topics Discussed:${colors.reset}`);
        meeting.summary.topics_discussed.slice(0, 5).forEach(topic => {
          console.log(`  • ${topic}`);
        });
      }

      if (meeting.summary.action_items && meeting.summary.action_items.length > 0) {
        console.log(`\n${colors.red}Action Items:${colors.reset}`);
        meeting.summary.action_items.forEach(item => {
          console.log(`  ✓ ${item}`);
        });
      }

      if (meeting.summary.bullet_gist && meeting.summary.bullet_gist.length > 0) {
        console.log(`\n${colors.blue}Key Points:${colors.reset}`);
        meeting.summary.bullet_gist.slice(0, 5).forEach(point => {
          console.log(`  • ${point}`);
        });
      }
    }
  }
}

// Main function
async function main() {
  try {
    // Load environment variables
    loadEnv();

    // Parse command line arguments
    const options = parseArgs();

    // Check for API key
    const apiKey = process.env.FIREFLIES_API_KEY;
    if (!apiKey) {
      console.error(`${colors.red}Error: FIREFLIES_API_KEY not found in environment variables or .env.local file${colors.reset}`);
      console.log(`\nPlease set your Fireflies API key:`);
      console.log(`  export FIREFLIES_API_KEY="your-api-key"`);
      console.log(`\nOr create a .env.local file with:`);
      console.log(`  FIREFLIES_API_KEY=your-api-key`);
      process.exit(1);
    }

    // Calculate date filter if days specified
    let toDate = null;
    if (options.days) {
      const date = new Date();
      date.setDate(date.getDate() - options.days);
      toDate = date.toISOString();
    }

    // Fetch transcripts
    console.log(`${colors.cyan}Fetching recent meetings from Fireflies...${colors.reset}\n`);
    const transcripts = await getTranscripts(apiKey, options.limit, toDate);

    if (transcripts.length === 0) {
      console.log(`${colors.yellow}No meetings found.${colors.reset}`);
      return;
    }

    // Output results
    if (options.json) {
      console.log(JSON.stringify(transcripts, null, 2));
    } else if (options.titles) {
      // Simple titles-only output
      console.log(`${colors.green}Found ${transcripts.length} meeting${transcripts.length !== 1 ? 's' : ''}:${colors.reset}\n`);
      transcripts.forEach((meeting, index) => {
        console.log(`${index + 1}. ${meeting.title}`);
      });
    } else {
      console.log(`${colors.green}Found ${transcripts.length} meeting${transcripts.length !== 1 ? 's' : ''}:${colors.reset}`);

      transcripts.forEach((meeting, index) => {
        displayMeeting(meeting, index, options.detailed);
      });

      // Summary statistics
      console.log(`\n${colors.dim}${'═'.repeat(60)}${colors.reset}`);
      console.log(`${colors.bright}Summary:${colors.reset}`);

      const totalDuration = transcripts.reduce((sum, m) => sum + (m.duration || 0), 0);
      const uniqueParticipants = new Set(
        transcripts.flatMap(m => m.participants || [])
      );

      console.log(`  • Total meetings: ${transcripts.length}`);
      console.log(`  • Total duration: ${formatDuration(totalDuration)}`);
      console.log(`  • Unique participants: ${uniqueParticipants.size}`);

      const meetingTypes = {};
      transcripts.forEach(m => {
        const type = m.summary?.meeting_type || 'Unspecified';
        meetingTypes[type] = (meetingTypes[type] || 0) + 1;
      });

      if (Object.keys(meetingTypes).length > 0) {
        console.log(`  • Meeting types:`);
        Object.entries(meetingTypes).forEach(([type, count]) => {
          console.log(`    - ${type}: ${count}`);
        });
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

// Run the script
if (require.main === module) {
  main();
}

module.exports = { getTranscripts, graphqlRequest };