#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://lgveqfnpkxvzbnnwuled.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxndmVxZm5wa3h2emJubnd1bGVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTI1NDE2NiwiZXhwIjoyMDcwODMwMTY2fQ.kIFo_ZSwO1uwpttYXxjSnYbBpUhwZhkW-ZGaiQLhKmA';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function checkSchema() {
  console.log('🔍 Checking document_metadata table schema...\n');

  // Get a sample row to see the column structure
  const { data, error } = await supabase
    .from('document_metadata')
    .select('*')
    .limit(1);

  if (error) {
    console.error('❌ Error fetching schema:', error.message);
    return;
  }

  if (data && data.length > 0) {
    const columns = Object.keys(data[0]);
    console.log('📋 Available columns in document_metadata:');
    columns.forEach(col => {
      const value = data[0][col];
      const type = Array.isArray(value) ? 'array' : typeof value;
      console.log(`   - ${col} (${type})`);
    });

    console.log('\n📄 Sample row:');
    console.log(JSON.stringify(data[0], null, 2));
  } else {
    console.log('⚠️ No data in the table');
  }
}

checkSchema().catch(console.error);