#!/usr/bin/env node

/**
 * Test script to fetch Fireflies transcripts since 9/12/2025
 * This script tests the Fireflies API integration and shows available transcripts
 */

const { createClient } = require('@supabase/supabase-js');

// Configuration - you'll need to set these values
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY || 'your-fireflies-api-key-here';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'your-service-key-here';

// Fireflies GraphQL endpoint
const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

class FirefliesClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async graphqlRequest(query, variables = {}) {
    console.log('🔍 Making Fireflies GraphQL request...');
    
    const response = await fetch(FIREFLIES_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Fireflies API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  async getTranscriptsSince(sinceDate, limit = 25) {
    const query = `
      query GetTranscripts($limit: Int, $fromDate: DateTime) {
        transcripts(limit: $limit, fromDate: $fromDate) {
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
          }
        }
      }
    `;

    const data = await this.graphqlRequest(query, {
      limit: Math.min(limit, 100),
      fromDate: sinceDate,
    });

    return data.transcripts || [];
  }

  async getTranscriptById(id) {
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
          }
        }
      }
    `;

    const data = await this.graphqlRequest(query, { id });
    return data.transcript;
  }

  formatTranscriptAsMarkdown(transcript) {
    let md = `# ${transcript.title}\n\n`;
    md += `**Date:** ${new Date(transcript.date).toLocaleString()}\n`;
    md += `**Duration:** ${Math.floor((transcript.duration || 0) / 60)} minutes\n`;
    md += `**Participants:** ${(transcript.participants || []).join(", ")}\n\n`;
    
    if (transcript.summary?.overview) {
      md += `## Summary\n${transcript.summary.overview}\n\n`;
    }
    
    if (Array.isArray(transcript.summary?.bullet_gist) && transcript.summary.bullet_gist.length) {
      md += `## Key Points\n` + transcript.summary.bullet_gist.map(x => `- ${x}`).join("\n") + "\n\n";
    }
    
    if (transcript.summary?.keywords?.length) {
      md += `## Keywords\n${transcript.summary.keywords.join(", ")}\n\n`;
    }
    
    if (Array.isArray(transcript.summary?.action_items) && transcript.summary.action_items.length) {
      md += `## Action Items\n` + transcript.summary.action_items.map(x => `- ${x}`).join("\n") + "\n\n";
    }
    
    if (transcript.sentences?.length) {
      md += `## Transcript\n\n`;
      let currentSpeaker = "";
      for (const sentence of transcript.sentences) {
        if (sentence.speaker_id !== currentSpeaker) {
          currentSpeaker = sentence.speaker_id;
          md += `\n**${currentSpeaker}:**\n`;
        }
        md += `${sentence.text} `;
      }
    }
    
    return md;
  }
}

async function testFirefliesFetch() {
  console.log('🚀 Testing Fireflies Transcript Fetch since 9/12/2025\n');

  // Validate API key
  if (!FIREFLIES_API_KEY || FIREFLIES_API_KEY === 'your-fireflies-api-key-here') {
    console.error('❌ FIREFLIES_API_KEY not set. Please set it in your environment or .env file');
    process.exit(1);
  }

  try {
    const fireflies = new FirefliesClient(FIREFLIES_API_KEY);
    
    // Fetch transcripts since 9/12/2025
    const sinceDate = '2025-09-12T00:00:00Z';
    console.log(`📅 Fetching transcripts since: ${sinceDate}`);
    
    const transcripts = await fireflies.getTranscriptsSince(sinceDate, 50);
    
    console.log(`\n✅ Found ${transcripts.length} transcripts since 9/12/2025:`);
    
    if (transcripts.length === 0) {
      console.log('📭 No transcripts found since 9/12/2025');
      console.log('💡 This could mean:');
      console.log('   - No meetings were recorded since that date');
      console.log('   - The API key might not have access to recent transcripts');
      console.log('   - The date format might need adjustment');
      return;
    }

    // Display summary of each transcript
    console.log('\n📊 Transcript Summary:');
    transcripts.forEach((transcript, index) => {
      console.log(`\n${index + 1}. ${transcript.title || 'Untitled'}`);
      console.log(`   ID: ${transcript.id}`);
      console.log(`   Date: ${new Date(transcript.date).toLocaleString()}`);
      console.log(`   Duration: ${Math.floor((transcript.duration || 0) / 60)} minutes`);
      console.log(`   Participants: ${transcript.participants?.length || 0} people`);
      console.log(`   Keywords: ${transcript.summary?.keywords?.length || 0} keywords`);
      console.log(`   Action Items: ${transcript.summary?.action_items?.length || 0} items`);
    });

    // Fetch full details for the first transcript as a test
    if (transcripts.length > 0) {
      console.log(`\n📝 Fetching full details for first transcript: ${transcripts[0].title}`);
      
      const fullTranscript = await fireflies.getTranscriptById(transcripts[0].id);
      
      if (fullTranscript) {
        console.log(`✅ Successfully fetched full transcript with ${fullTranscript.sentences?.length || 0} sentences`);
        
        // Generate markdown
        const markdown = fireflies.formatTranscriptAsMarkdown(fullTranscript);
        console.log(`\n📄 Generated markdown (${markdown.length} characters):`);
        console.log('Preview (first 500 chars):');
        console.log(markdown.substring(0, 500) + '...');
        
        // Test database connectivity (optional)
        if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY !== 'your-service-key-here') {
          console.log('\n🗄️ Testing Supabase connection...');
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
          
          // Test if we can query the documents table
          const { data, error } = await supabase
            .from('documents')
            .select('id, title')
            .limit(1);
            
          if (error) {
            console.log(`⚠️ Supabase query failed: ${error.message}`);
          } else {
            console.log('✅ Supabase connection successful');
          }
        }
      }
    }

    console.log('\n🎉 Test completed successfully!');
    console.log('\n💡 Next steps:');
    console.log('   1. Use `pnpm dev` to start the worker locally');
    console.log('   2. Test the sync endpoint: POST /api/sync');
    console.log('   3. Process individual transcripts: POST /api/process');

  } catch (error) {
    console.error('❌ Error during test:', error.message);
    
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log('\n💡 Authentication failed. Please check:');
      console.log('   - Your Fireflies API key is correct');
      console.log('   - The API key has the necessary permissions');
      console.log('   - You are authenticated with Fireflies');
    }
    
    if (error.message.includes('GraphQL')) {
      console.log('\n💡 GraphQL error. This might indicate:');
      console.log('   - Invalid query parameters');
      console.log('   - Date format issues');
      console.log('   - API schema changes');
    }
    
    process.exit(1);
  }
}

// Run the test
testFirefliesFetch().catch(console.error);