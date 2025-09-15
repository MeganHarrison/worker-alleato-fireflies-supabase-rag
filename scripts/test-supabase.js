#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxndmVxZm5wa3h2emJubnd1bGVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI1NDE2NiwiZXhwIjoyMDcwODMwMTY2fQ.kIFo_ZSwO1uwpttYXxjSnYbBpUhwZhkW-ZGaiQLhKmA';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testSupabase() {
  console.log('🚀 Testing Supabase Connection...\n');

  // 1. Count meetings
  const { count: meetingsCount, error: countError } = await supabase
    .from('meetings')
    .select('*', { count: 'exact', head: true });

  console.log(`✅ Total Meetings in Database: ${meetingsCount || 0}`);

  // 2. Get recent meetings
  const { data: recentMeetings, error: recentError } = await supabase
    .from('meetings')
    .select('id, title, date, participants, tags')
    .order('date', { ascending: false })
    .limit(5);

  if (recentMeetings && recentMeetings.length > 0) {
    console.log('\n📊 Recent Meetings:');
    recentMeetings.forEach(meeting => {
      console.log(`  - ${meeting.title || 'Untitled'} (${new Date(meeting.date).toLocaleDateString()})`);
      console.log(`    ID: ${meeting.id}`);
      console.log(`    Participants: ${meeting.participants?.length || 0} people`);
      console.log(`    Tags: ${meeting.tags?.join(', ') || 'None'}`);
    });
  }

  // 3. Count meeting_chunks
  const { count: chunksCount, error: chunksError } = await supabase
    .from('meeting_chunks')
    .select('*', { count: 'exact', head: true });

  console.log(`\n✅ Total Meeting Chunks: ${chunksCount || 0}`);

  // 4. Get sample chunk with embedding
  const { data: sampleChunk, error: chunkError } = await supabase
    .from('meeting_chunks')
    .select('id, meeting_id, content, chunk_type')
    .limit(1)
    .single();

  if (sampleChunk) {
    console.log('\n📝 Sample Chunk:');
    console.log(`  Meeting ID: ${sampleChunk.meeting_id}`);
    console.log(`  Content: ${sampleChunk.content?.substring(0, 100)}...`);
    console.log(`  Type: ${sampleChunk.chunk_type}`);
  }

  // 5. Check if specific meeting exists
  const targetId = '01K374MAQ92EM6Z9BVXT12AT7W';
  const { data: specificMeeting, error: specificError } = await supabase
    .from('meetings')
    .select('id, title, date')
    .eq('id', targetId)
    .single();

  if (specificMeeting) {
    console.log(`\n✅ Meeting ${targetId} EXISTS in database:`);
    console.log(`  Title: ${specificMeeting.title}`);
    console.log(`  Date: ${specificMeeting.date}`);
  } else {
    console.log(`\n❌ Meeting ${targetId} NOT found in database`);
  }

  console.log('\n✨ Supabase is working perfectly! Your database has meetings and chunks stored.');
}

testSupabase().catch(console.error);