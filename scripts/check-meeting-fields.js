require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function downloadAndCheckFile(fileName) {
  try {
    console.log(`\n📄 Downloading ${fileName}...`);
    
    // Try both with and without transcripts/ prefix
    let data, error;
    
    ({ data, error } = await supabase.storage.from('meetings').download(`transcripts/${fileName}`));
    
    if (error) {
      // Try without prefix
      ({ data, error } = await supabase.storage.from('meetings').download(fileName));
    }
    
    if (error) {
      console.error('❌ Download error:', error);
      return;
    }
    
    const content = await data.text();
    
    console.log('\n📊 Content Analysis for', fileName);
    console.log('File size:', content.length, 'characters');
    
    // Check for all possible fields
    const fields = [
      'Summary',
      'Short Overview', 
      'Gist',
      'Short Summary',
      'Outline',
      'Key Points',
      'Shorthand Bullets',
      'Topics Discussed',
      'Meeting Type',
      'Chapters',
      'Keywords',
      'Action Items',
      'Transcript'
    ];
    
    const presentFields = [];
    const missingFields = [];
    
    fields.forEach(field => {
      if (content.includes(`## ${field}`)) {
        presentFields.push(field);
      } else {
        missingFields.push(field);
      }
    });
    
    console.log(`\n✅ Fields present (${presentFields.length}/${fields.length}):`);
    presentFields.forEach(field => console.log(`  ✓ ${field}`));
    
    if (missingFields.length > 0) {
      console.log(`\n⚠️  Fields missing (${missingFields.length}/${fields.length}):`);
      missingFields.forEach(field => console.log(`  ✗ ${field}`));
    }
    
    // Show first 500 chars to verify content
    console.log('\n📝 Content preview (first 500 chars):');
    console.log(content.substring(0, 500) + '...');
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

async function checkRecentFiles() {
  console.log('🚀 Checking Meeting Files for New Summary Fields...\n');
  
  // List of recent files to check
  const filesToCheck = [
    '2025-09-18 - Daily TB.md',
    '2025-09-18 - McCray GW Bloomington Meeting.md',
    '2025-09-16 - Daily TB.md'
  ];
  
  for (const file of filesToCheck) {
    await downloadAndCheckFile(file);
    console.log('\n' + '='.repeat(60));
  }
}

checkRecentFiles();
