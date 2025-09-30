#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxndmVxZm5wa3h2emJubnd1bGVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI1NDE2NiwiZXhwIjoyMDcwODMwMTY2fQ.kIFo_ZSwO1uwpttYXxjSnYbBpUhwZhkW-ZGaiQLhKmA';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkStorageFiles() {
  console.log('🚀 Checking Storage Files...\n');

  try {
    // Get all files in the meetings bucket root
    const { data: files, error } = await supabase
      .storage
      .from('meetings')
      .list('', { 
        limit: 100,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error) {
      console.error('❌ Error fetching files:', error);
      return;
    }

    console.log(`📁 Total files in meetings bucket (root): ${files.length}`);
    
    // Show recent files to see naming convention
    console.log('\n📊 Recent Files in bucket root (showing new naming convention):');
    files.slice(0, 10).forEach((file, index) => {
      const size = (file.metadata?.size / 1024).toFixed(1);
      const created = new Date(file.created_at).toLocaleString();
      console.log(`${index + 1}. ${file.name}`);
      console.log(`   Size: ${size}KB | Created: ${created}`);
    });

    // Look for files with the new naming convention (YYYY-MM-DD format)
    const newFormatFiles = files.filter(file => 
      file.name.match(/^\d{4}-\d{2}-\d{2} - .+\.md$/)
    );
    
    console.log(`\n✅ Files with new naming convention: ${newFormatFiles.length}`);
    if (newFormatFiles.length > 0) {
      console.log('📝 Examples of new format:');
      newFormatFiles.slice(0, 5).forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.name}`);
      });
    }

    // Look for files with old naming convention (just Fireflies ID)
    const oldFormatFiles = files.filter(file => 
      file.name.match(/^01K[A-Z0-9]+\.md$/)
    );
    
    console.log(`\n📋 Files with old naming convention: ${oldFormatFiles.length}`);

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkStorageFiles().catch(console.error);