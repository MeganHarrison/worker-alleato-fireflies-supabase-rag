#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

// Configuration
const FIREFLIES_API_KEY = '1d590920-152d-408b-a829-14489ef07538';
const SUPABASE_URL = 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxndmVxZm5wa3h2emJubnd1bGVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI1NDE2NiwiZXhwIjoyMDcwODMwMTY2fQ.kIFo_ZSwO1uwpttYXxjSnYbBpUhwZhkW-ZGaiQLhKmA';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function graphqlRequest(query, variables = {}) {
  const response = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

async function getTranscripts(limit = 5) {
  console.log(`📋 Fetching ${limit} recent transcripts...`);
  const query = `
    query GetTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id title transcript_url duration date participants
        summary {
          keywords
          action_items
          overview
          bullet_gist
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { limit });
  return data.transcripts || [];
}

async function getTranscriptById(id) {
  console.log(`📄 Fetching full transcript for ${id}...`);
  const startTime = Date.now();

  const query = `
    query GetTranscriptContent($id: String!) {
      transcript(id: $id) {
        id title transcript_url duration date participants
        sentences { text speaker_id start_time }
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

  const data = await graphqlRequest(query, { id });
  const elapsedTime = Date.now() - startTime;
  console.log(`   ⏱️  Fetched in ${elapsedTime}ms`);

  return data.transcript;
}

async function checkExistingDocument(firefliesId) {
  const { data, error } = await supabase
    .from('document_metadata')
    .select('id, title, created_at')
    .eq('fireflies_id', firefliesId)
    .maybeSingle();

  return data;
}

async function formatTranscriptAsMarkdown(t) {
  let md = `# ${t.title}\n\n`;
  md += `**Date:** ${new Date(t.date).toLocaleString()}\n`;
  md += `**Duration:** ${Math.floor((t.duration || 0) / 60)} minutes\n`;
  md += `**Participants:** ${(t.participants || []).join(", ")}\n\n`;

  if (t.summary?.overview) {
    md += `## Summary\n${t.summary.overview}\n\n`;
  }

  if (t.summary?.keywords?.length) {
    md += `## Keywords\n${t.summary.keywords.join(", ")}\n\n`;
  }

  if (Array.isArray(t.summary?.action_items) && t.summary.action_items.length) {
    md += `## Action Items\n` + t.summary.action_items.map(x => `- ${x}`).join("\n") + "\n\n";
  }

  if (t.sentences?.length) {
    md += `## Transcript\n\n`;
    let cur = "";
    for (const s of t.sentences) {
      if (s.speaker_id !== cur) {
        cur = s.speaker_id;
        md += `\n**${cur}:**\n`;
      }
      md += `${s.text} `;
    }
  }

  return md;
}

async function uploadTranscript(transcriptId, content, metadata) {
  const date = new Date(metadata.date);
  const dateStr = date.toISOString().split('T')[0];

  const cleanTitle = metadata.title
    .replace(/[^a-zA-Z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);

  const fileName = `${dateStr} - ${cleanTitle}.md`;

  console.log(`   📤 Uploading to storage: ${fileName}`);

  const { error } = await supabase.storage
    .from('meetings')
    .upload(fileName, content, {
      contentType: "text/markdown",
      upsert: true
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage
    .from('meetings')
    .getPublicUrl(fileName);

  return data.publicUrl;
}

async function saveMeeting(meta, fileUrl, markdownContent) {
  console.log(`   💾 Saving to document_metadata table...`);

  const documentId = meta.id;

  const { data, error } = await supabase
    .from('document_metadata')
    .upsert({
      id: documentId,
      fireflies_id: meta.id,
      title: meta.title,
      url: fileUrl,  // Changed from file_url to url
      source: 'fireflies',
      content: markdownContent,
      date: new Date(meta.date).toISOString(),
      participants: meta.participants || [],
      action_items: meta.summary?.action_items || [],
      bullet_points: meta.summary?.bullet_gist || [],
      duration_minutes: meta.duration ? Math.floor(meta.duration / 60) : null,
      type: 'meeting',
      fireflies_link: `https://app.fireflies.ai/view/${meta.id}`,
      created_at: new Date().toISOString()
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Database save failed: ${error.message}`);
  }

  return data.id;
}

async function processTranscript(transcriptId) {
  console.log(`\n🔄 Processing transcript ${transcriptId}...`);

  // Check if already exists
  const existing = await checkExistingDocument(transcriptId);
  if (existing) {
    console.log(`   ✅ Already exists: "${existing.title}"`);
    return { skipped: true, id: existing.id };
  }

  // Fetch full transcript with sentences
  const transcript = await getTranscriptById(transcriptId);
  if (!transcript) {
    throw new Error(`Transcript not found: ${transcriptId}`);
  }

  console.log(`   📝 Title: "${transcript.title}"`);
  console.log(`   👥 Participants: ${transcript.participants?.length || 0}`);
  console.log(`   💬 Sentences: ${transcript.sentences?.length || 0}`);

  // Format as markdown
  const markdown = await formatTranscriptAsMarkdown(transcript);
  console.log(`   📄 Generated markdown: ${markdown.length} characters`);

  // Extract metadata
  const metadata = {
    id: transcript.id,
    title: transcript.title,
    date: transcript.date,
    duration: transcript.duration,
    participants: transcript.participants || [],
    summary: transcript.summary
  };

  // Upload to storage
  const fileUrl = await uploadTranscript(transcriptId, markdown, metadata);

  // Save to database
  const documentId = await saveMeeting(metadata, fileUrl, markdown);

  console.log(`   ✅ Successfully saved with ID: ${documentId}`);
  return { success: true, id: documentId };
}

async function main() {
  console.log('🚀 Local Sync Test\n');

  try {
    // Get recent transcripts
    const transcripts = await getTranscripts(3);
    console.log(`\n📊 Found ${transcripts.length} transcripts\n`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    // Process each transcript
    for (const tr of transcripts) {
      try {
        const result = await processTranscript(tr.id);
        if (result.skipped) {
          skipped++;
        } else {
          processed++;
        }
      } catch (error) {
        failed++;
        errors.push({
          transcript_id: tr.id,
          title: tr.title,
          error: error.message
        });
        console.error(`   ❌ Error: ${error.message}`);
      }

      // Small delay between transcripts
      await new Promise(r => setTimeout(r, 500));
    }

    // Summary
    console.log('\n📊 Summary:');
    console.log(`   ✅ Processed: ${processed}`);
    console.log(`   ⏭️  Skipped (already exists): ${skipped}`);
    console.log(`   ❌ Failed: ${failed}`);

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(e => {
        console.log(`   - ${e.title}: ${e.error}`);
      });
    }

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);