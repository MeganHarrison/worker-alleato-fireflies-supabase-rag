#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxndmVxZm5wa3h2emJubnd1bGVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI1NDE2NiwiZXhwIjoyMDcwODMwMTY2fQ.kIFo_ZSwO1uwpttYXxjSnYbBpUhwZhkW-ZGaiQLhKmA';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDocuments() {
  console.log('🚀 Checking Documents Table...\n');

  // Check documents table
  const { count: documentsCount, error: countError } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true });

  console.log(`✅ Total Documents in Database: ${documentsCount || 0}`);

  if (documentsCount > 0) {
    // Get recent documents
    const { data: recentDocs, error: recentError } = await supabase
      .from('documents')
      .select('id, title, source, fireflies_id, date, participants, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (recentDocs && recentDocs.length > 0) {
      console.log('\n📊 Recent Documents:');
      recentDocs.forEach((doc, index) => {
        console.log(`\n${index + 1}. ${doc.title || 'Untitled'}`);
        console.log(`   ID: ${doc.id}`);
        console.log(`   Fireflies ID: ${doc.fireflies_id}`);
        console.log(`   Source: ${doc.source}`);
        console.log(`   Date: ${new Date(doc.date).toLocaleDateString()}`);
        console.log(`   Participants: ${doc.participants?.length || 0} people`);
        console.log(`   Created: ${new Date(doc.created_at).toLocaleString()}`);
      });
    }

    // Check document_chunks table
    const { count: chunksCount, error: chunksError } = await supabase
      .from('document_chunks')
      .select('*', { count: 'exact', head: true });

    console.log(`\n✅ Total Document Chunks: ${chunksCount || 0}`);

    // Check storage
    const { data: files, error: storageError } = await supabase
      .storage
      .from('meetings')
      .list('transcripts', { limit: 100 });

    if (files) {
      console.log(`\n📁 Storage Files: ${files.length} files in meetings/transcripts/`);
      files.slice(0, 5).forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.name} (${(file.metadata?.size / 1024).toFixed(1)}KB)`);
      });
      if (files.length > 5) {
        console.log(`   ... and ${files.length - 5} more files`);
      }
    }
  }

  console.log('\n✨ Document check complete!');
}

checkDocuments().catch(console.error);