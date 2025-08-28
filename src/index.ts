import { createClient, SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { 
  Env, 
  TranscriptMetadata, 
  TranscriptChunk, 
  VectorSearchResult,
  FirefliesTranscript,
  FirefliesWebhookPayload,
  ProcessingOptions,
  SearchOptions,
  SyncResult,
  AnalyticsData,
  ConversationThread,
  WebhookVerification
} from './types';
import { CacheService } from './services/cache';
import { RateLimiter } from './services/rate-limiter';
import { Logger } from './services/logger';

// ===== Fireflies Client =====
class FirefliesClient {
  private apiKey: string;
  private baseUrl = 'https://api.fireflies.ai/graphql';
  private logger: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger.child({ service: 'FirefliesClient' });
  }

  async graphqlRequest(query: string, variables: Record<string, any> = {}) {
    this.logger.debug('Making GraphQL request', { query, variables });
    
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const error = new Error(`Fireflies API error: ${response.status} ${response.statusText}`);
      this.logger.error('Fireflies API request failed', error);
      throw error;
    }

    const data = await response.json<any>();
    if (data.errors) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      this.logger.error('GraphQL query failed', error, { errors: data.errors });
      throw error;
    }

    return data.data;
  }

  async getTranscripts(limit = 25, toDate: string | null = null): Promise<FirefliesTranscript[]> {
    const query = `
      query GetTranscripts($limit: Int, $toDate: DateTime) {
        transcripts(limit: $limit, toDate: $toDate) {
          title
          id
          transcript_url
          duration
          date
          participants
        }
      }
    `;

    const variables = {
      limit: Math.min(limit, 100),
      toDate,
    };

    const data = await this.graphqlRequest(query, variables);
    this.logger.info('Fetched transcripts', { count: data.transcripts.length });
    return data.transcripts;
  }

  async getTranscriptById(transcriptId: string): Promise<FirefliesTranscript> {
    this.logger.debug('Fetching transcript', { transcriptId });
    
    const query = `
      query GetTranscriptContent($id: String!) {
        transcript(id: $id) {
          title
          id
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
          }
        }
      }
    `;

    const variables = { id: transcriptId };
    const data = await this.graphqlRequest(query, variables);
    return data.transcript;
  }

  formatTranscriptAsMarkdown(transcript: FirefliesTranscript): string {
    let markdown = `# ${transcript.title}\n\n`;
    markdown += `**Date:** ${new Date(transcript.date).toLocaleString()}\n`;
    markdown += `**Duration:** ${Math.floor(transcript.duration / 60)} minutes\n`;
    markdown += `**Participants:** ${transcript.participants.join(', ')}\n\n`;

    if (transcript.summary?.keywords?.length > 0) {
      markdown += `## Keywords\n${transcript.summary.keywords.join(', ')}\n\n`;
    }

    if (transcript.summary?.action_items && Array.isArray(transcript.summary.action_items) && transcript.summary.action_items.length > 0) {
      markdown += `## Action Items\n`;
      transcript.summary.action_items.forEach((item: string) => {
        markdown += `- ${item}\n`;
      });
      markdown += '\n';
    }

    if (transcript.sentences?.length > 0) {
      markdown += `## Transcript\n\n`;
      let currentSpeaker = '';
      
      transcript.sentences.forEach((sentence: any) => {
        if (sentence.speaker_id !== currentSpeaker) {
          currentSpeaker = sentence.speaker_id;
          markdown += `\n**${currentSpeaker}:**\n`;
        }
        markdown += `${sentence.text} `;
      });
    }

    return markdown;
  }

  extractMetadata(transcript: FirefliesTranscript): TranscriptMetadata {
    return {
      id: transcript.id,
      title: transcript.title,
      date: transcript.date,
      duration: transcript.duration,
      participants: transcript.participants,
      speakerCount: new Set(transcript.sentences?.map((s: any) => s.speaker_id) || []).size,
      summary: transcript.summary,
    };
  }
}

// ===== Enhanced Chunking Strategy =====
class ChunkingStrategy {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: 'ChunkingStrategy' });
  }

  chunkTranscript(transcript: FirefliesTranscript, options: ProcessingOptions = {}) {
    const {
      maxChunkSize = 500,
      overlap = 50,
      bySpeaker = true,
    } = options;

    this.logger.debug('Chunking transcript', { 
      transcriptId: transcript.id, 
      options 
    });

    const chunks: any[] = [];
    
    if (!transcript.sentences || transcript.sentences.length === 0) {
      this.logger.warn('No sentences in transcript', { transcriptId: transcript.id });
      return chunks;
    }

    if (bySpeaker) {
      // Group sentences by speaker and detect conversation threads
      const speakerGroups = this.groupBySpeaker(transcript.sentences);
      const threads = this.detectConversationThreads(speakerGroups);
      
      // Create chunks from speaker groups with thread info
      speakerGroups.forEach((group) => {
        const text = group.sentences.map((s: any) => s.text).join(' ');
        const words = text.split(/\s+/);
        const thread = threads.find(t => 
          t.startTime <= group.startTime && t.endTime >= group.endTime
        );

        for (let i = 0; i < words.length; i += maxChunkSize - overlap) {
          const chunkWords = words.slice(i, i + maxChunkSize);
          if (chunkWords.length > 0) {
            chunks.push({
              text: chunkWords.join(' '),
              speaker: group.speaker,
              startTime: i === 0 ? group.startTime : null,
              endTime: i + maxChunkSize >= words.length ? group.endTime : null,
              chunkIndex: chunks.length,
              conversationThread: thread?.id,
            });
          }
        }
      });
    } else {
      // Simple text-based chunking
      const fullText = transcript.sentences.map((s: any) => s.text).join(' ');
      const words = fullText.split(/\s+/);

      for (let i = 0; i < words.length; i += maxChunkSize - overlap) {
        const chunkWords = words.slice(i, i + maxChunkSize);
        if (chunkWords.length > 0) {
          chunks.push({
            text: chunkWords.join(' '),
            chunkIndex: chunks.length,
          });
        }
      }
    }

    this.logger.info('Created chunks', { 
      transcriptId: transcript.id, 
      chunkCount: chunks.length 
    });
    
    return chunks;
  }

  private groupBySpeaker(sentences: any[]): any[] {
    const groups: any[] = [];
    let currentGroup: any = null;

    sentences.forEach((sentence) => {
      if (!currentGroup || currentGroup.speaker !== sentence.speaker_id) {
        if (currentGroup) {
          groups.push(currentGroup);
        }
        currentGroup = {
          speaker: sentence.speaker_id,
          sentences: [],
          startTime: sentence.start_time,
          endTime: sentence.start_time,
        };
      }
      currentGroup.sentences.push(sentence);
      currentGroup.endTime = sentence.start_time;
    });

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private detectConversationThreads(speakerGroups: any[]): ConversationThread[] {
    const threads: ConversationThread[] = [];
    let currentThread: ConversationThread | null = null;
    const threadGapThreshold = 30; // 30 seconds gap means new thread

    speakerGroups.forEach((group, index) => {
      const previousGroup = index > 0 ? speakerGroups[index - 1] : null;
      
      if (!previousGroup || 
          group.startTime - previousGroup.endTime > threadGapThreshold) {
        // Start new thread
        if (currentThread) {
          threads.push(currentThread);
        }
        currentThread = {
          id: `thread-${threads.length + 1}`,
          topic: '', // Would need NLP to extract topic
          chunks: [],
          participants: [group.speaker],
          startTime: group.startTime,
          endTime: group.endTime,
        };
      } else if (currentThread) {
        // Continue thread
        currentThread.endTime = group.endTime;
        if (!currentThread.participants.includes(group.speaker)) {
          currentThread.participants.push(group.speaker);
        }
      }
    });

    if (currentThread) {
      threads.push(currentThread);
    }

    return threads;
  }
}

// ===== Enhanced Vectorization Service =====
class VectorizationService {
  private cache: CacheService;
  private logger: Logger;

  constructor(private ai: Ai, cache: CacheService, logger: Logger) {
    this.cache = cache;
    this.logger = logger.child({ service: 'VectorizationService' });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Check cache first
    const cached = await this.cache.getEmbedding(text);
    if (cached) {
      this.logger.debug('Using cached embedding');
      return cached;
    }

    this.logger.debug('Generating new embedding');
    const response = await this.ai.run('@cf/baai/bge-base-en-v1.5', {
      text,
    });

    const embedding = (response as any).data[0];
    
    // Cache the embedding
    await this.cache.setEmbedding(text, embedding);
    
    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    this.logger.debug('Generating embeddings batch', { count: texts.length });
    
    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await Promise.all(
        batch.map(text => this.generateEmbedding(text))
      );
      embeddings.push(...batchEmbeddings);
      
      // Add small delay between batches
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return embeddings;
  }
}

// ===== Enhanced Database Service =====
class DatabaseService {
  private sql: ReturnType<typeof postgres>;
  private logger: Logger;

  constructor(connectionString: string, logger: Logger) {
    this.sql = postgres(connectionString, {
      max: 5,
      fetch_types: false,
    });
    this.logger = logger.child({ service: 'DatabaseService' });
  }

  async saveMeeting(metadata: TranscriptMetadata, fileUrl: string): Promise<void> {
    this.logger.debug('Saving meeting', { meetingId: metadata.id });
    
    await this.sql`
      INSERT INTO meetings (
        id, title, date, duration, participants, speaker_count,
        meeting_type, department, project, keywords, action_items,
        file_url, created_at, updated_at
      ) VALUES (
        ${metadata.id}, ${metadata.title}, ${metadata.date}, ${metadata.duration},
        ${metadata.participants}, ${metadata.speakerCount}, ${metadata.meetingType},
        ${metadata.department}, ${metadata.project}, 
        ${metadata.summary?.keywords || []}, ${metadata.summary?.action_items || []},
        ${fileUrl}, NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        date = EXCLUDED.date,
        duration = EXCLUDED.duration,
        participants = EXCLUDED.participants,
        speaker_count = EXCLUDED.speaker_count,
        meeting_type = EXCLUDED.meeting_type,
        department = EXCLUDED.department,
        project = EXCLUDED.project,
        keywords = EXCLUDED.keywords,
        action_items = EXCLUDED.action_items,
        file_url = EXCLUDED.file_url,
        updated_at = NOW()
    `;
    
    this.logger.info('Meeting saved', { meetingId: metadata.id });
  }

  async saveChunks(transcriptId: string, chunks: TranscriptChunk[]): Promise<void> {
    this.logger.debug('Saving chunks', { 
      transcriptId, 
      chunkCount: chunks.length 
    });
    
    // Delete existing chunks for this transcript
    await this.sql`DELETE FROM meetings_chunks WHERE transcript_id = ${transcriptId}`;

    // Insert new chunks with embeddings
    for (const chunk of chunks) {
      await this.sql`
        INSERT INTO meetings_chunks (
          transcript_id, chunk_index, text, speaker,
          start_time, end_time, embedding, conversation_thread, created_at
        ) VALUES (
          ${chunk.transcript_id}, ${chunk.chunk_index}, ${chunk.text},
          ${chunk.speaker}, ${chunk.start_time}, ${chunk.end_time},
          ${JSON.stringify(chunk.embedding)}, ${chunk.conversation_thread}, NOW()
        )
      `;
    }
    
    this.logger.info('Chunks saved', { 
      transcriptId, 
      chunkCount: chunks.length 
    });
  }

  async vectorSearch(
    queryEmbedding: number[],
    options: SearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const {
      limit = 10,
      threshold = 0.7,
      filters = {},
    } = options;

    this.logger.debug('Performing vector search', { options });

    // Build dynamic WHERE clause
    const conditions = [`1 - (c.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) > ${threshold}`];
    
    if (filters.department) {
      conditions.push(`m.department = ${filters.department}`);
    }
    if (filters.project) {
      conditions.push(`m.project = ${filters.project}`);
    }
    if (filters.dateFrom) {
      conditions.push(`m.date >= ${filters.dateFrom}`);
    }
    if (filters.dateTo) {
      conditions.push(`m.date <= ${filters.dateTo}`);
    }

    const whereClause = conditions.join(' AND ');

    const results = await this.sql`
      SELECT 
        c.*,
        m.title, m.date, m.duration, m.participants,
        m.speaker_count, m.meeting_type, m.department,
        m.project, m.keywords, m.action_items,
        1 - (c.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as similarity
      FROM meetings_chunks c
      JOIN meetings m ON c.transcript_id = m.id
      WHERE ${this.sql.unsafe(whereClause)}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    this.logger.info('Vector search completed', { 
      resultCount: results.length 
    });

    return results.map((row: any) => ({
      chunk: {
        transcript_id: row.transcript_id,
        chunk_index: row.chunk_index,
        text: row.text,
        speaker: row.speaker,
        start_time: row.start_time,
        end_time: row.end_time,
        embedding: row.embedding,
        conversation_thread: row.conversation_thread,
      },
      similarity: row.similarity,
      metadata: {
        id: row.transcript_id,
        title: row.title,
        date: row.date,
        duration: row.duration,
        participants: row.participants,
        speakerCount: row.speaker_count,
        meetingType: row.meeting_type,
        department: row.department,
        project: row.project,
        summary: {
          keywords: row.keywords,
          action_items: row.action_items,
        },
      },
      highlight: options.includeHighlights ? this.generateHighlight(row.text, queryEmbedding.toString()) : undefined,
    }));
  }

  private generateHighlight(text: string, query: string): string {
    // Simple highlight generation - in production, use more sophisticated NLP
    const words = text.split(/\s+/);
    const excerpt = words.slice(0, 30).join(' ');
    return excerpt + (words.length > 30 ? '...' : '');
  }

  async getAnalytics(): Promise<AnalyticsData> {
    this.logger.debug('Generating analytics');

    const [
      totalMeetings,
      durationStats,
      topSpeakers,
      topKeywords,
      departmentBreakdown,
      projectBreakdown,
    ] = await Promise.all([
      this.sql`SELECT COUNT(*) as count FROM meetings`,
      this.sql`SELECT SUM(duration) as total, AVG(duration) as average FROM meetings`,
      this.sql`
        SELECT unnest(participants) as name, COUNT(*) as count
        FROM meetings
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
      `,
      this.sql`
        SELECT unnest(keywords) as keyword, COUNT(*) as frequency
        FROM meetings
        WHERE keywords IS NOT NULL
        GROUP BY keyword
        ORDER BY frequency DESC
        LIMIT 20
      `,
      this.sql`
        SELECT department, COUNT(*) as count
        FROM meetings
        WHERE department IS NOT NULL
        GROUP BY department
        ORDER BY count DESC
      `,
      this.sql`
        SELECT project, COUNT(*) as count
        FROM meetings
        WHERE project IS NOT NULL
        GROUP BY project
        ORDER BY count DESC
      `,
    ]);

    return {
      totalMeetings: totalMeetings[0].count,
      totalDuration: durationStats[0].total || 0,
      averageDuration: durationStats[0].average || 0,
      topSpeakers: topSpeakers.map((r: any) => ({ name: r.name, count: r.count })),
      topKeywords: topKeywords.map((r: any) => ({ keyword: r.keyword, frequency: r.frequency })),
      departmentBreakdown: departmentBreakdown.map((r: any) => ({ department: r.department, count: r.count })),
      projectBreakdown: projectBreakdown.map((r: any) => ({ project: r.project, count: r.count })),
      sentimentAnalysis: {
        positive: 0, // Would need sentiment analysis
        neutral: 0,
        negative: 0,
      },
    };
  }

  async cleanup(): Promise<void> {
    await this.sql.end();
  }
}

// ===== Supabase Storage Service =====
class SupabaseStorageService {
  private client: SupabaseClient;
  private bucketName = 'meetings';
  private logger: Logger;

  constructor(client: SupabaseClient, logger: Logger) {
    this.client = client;
    this.logger = logger.child({ service: 'SupabaseStorage' });
  }

  async uploadTranscript(transcriptId: string, content: string): Promise<string> {
    const fileName = `transcripts/${transcriptId}.md`;
    
    this.logger.debug('Uploading transcript', { transcriptId, fileName });
    
    const { error } = await this.client.storage
      .from(this.bucketName)
      .upload(fileName, content, {
        contentType: 'text/markdown',
        upsert: true,
      });

    if (error) {
      this.logger.error('Failed to upload transcript', error);
      throw new Error(`Failed to upload transcript: ${error.message}`);
    }

    // Return public URL
    const { data } = this.client.storage
      .from(this.bucketName)
      .getPublicUrl(fileName);

    this.logger.info('Transcript uploaded', { transcriptId, url: data.publicUrl });
    return data.publicUrl;
  }

  async getTranscript(transcriptId: string): Promise<string | null> {
    const fileName = `transcripts/${transcriptId}.md`;
    
    const { data, error } = await this.client.storage
      .from(this.bucketName)
      .download(fileName);

    if (error) {
      this.logger.error('Failed to download transcript', error);
      return null;
    }

    return await data.text();
  }
}

// ===== Enhanced Transcript Processor =====
class TranscriptProcessor {
  private firefliesClient: FirefliesClient;
  private chunkingStrategy: ChunkingStrategy;
  private vectorizationService: VectorizationService;
  private storageService: SupabaseStorageService;
  private databaseService: DatabaseService;
  private cache: CacheService;
  private logger: Logger;

  constructor(env: Env) {
    this.logger = new Logger('info');
    this.cache = new CacheService(env.CACHE, env.VECTOR_CACHE_TTL);
    
    // Initialize Supabase client
    const supabaseClient = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_KEY
    );

    // Initialize services
    this.firefliesClient = new FirefliesClient(env.FIREFLIES_API_KEY, this.logger);
    this.chunkingStrategy = new ChunkingStrategy(this.logger);
    this.vectorizationService = new VectorizationService(env.AI, this.cache, this.logger);
    this.storageService = new SupabaseStorageService(supabaseClient, this.logger);
    this.databaseService = new DatabaseService(env.HYPERDRIVE.connectionString, this.logger);
  }

  async processTranscript(
    transcriptId: string, 
    options: ProcessingOptions = {}
  ): Promise<void> {
    const processLogger = this.logger.child({ transcriptId });
    
    try {
      processLogger.info('Processing transcript');

      // 1. Check if already processed recently
      const cached = await this.cache.get('processed', transcriptId);
      if (cached) {
        processLogger.info('Transcript recently processed, skipping');
        return;
      }

      // 2. Fetch transcript from Fireflies
      const transcript = await this.firefliesClient.getTranscriptById(transcriptId);
      if (!transcript) {
        throw new Error(`Transcript ${transcriptId} not found`);
      }

      // 3. Format and extract metadata
      const markdown = this.firefliesClient.formatTranscriptAsMarkdown(transcript);
      const metadata = this.firefliesClient.extractMetadata(transcript);

      // 4. Enrich metadata if requested
      if (options.detectSentiment) {
        // Would need sentiment analysis here
        metadata.sentiment = 'neutral';
      }

      // 5. Upload to Supabase Storage
      const fileUrl = await this.storageService.uploadTranscript(transcriptId, markdown);

      // 6. Save meeting metadata
      await this.databaseService.saveMeeting(metadata, fileUrl);

      // 7. Chunk the transcript
      const chunks = this.chunkingStrategy.chunkTranscript(transcript, options);

      // 8. Generate embeddings
      const chunkTexts = chunks.map(c => c.text);
      const embeddings = await this.vectorizationService.generateEmbeddings(chunkTexts);

      // 9. Prepare chunks with embeddings
      const chunksWithEmbeddings: TranscriptChunk[] = chunks.map((chunk, index) => ({
        transcript_id: transcriptId,
        chunk_index: chunk.chunkIndex,
        text: chunk.text,
        speaker: chunk.speaker,
        start_time: chunk.startTime,
        end_time: chunk.endTime,
        embedding: embeddings[index],
        conversation_thread: chunk.conversationThread,
      }));

      // 10. Save chunks
      await this.databaseService.saveChunks(transcriptId, chunksWithEmbeddings);

      // 11. Mark as processed in cache
      await this.cache.set('processed', transcriptId, true, 3600);

      processLogger.info('Successfully processed transcript');
    } catch (error) {
      processLogger.error('Error processing transcript', error as Error);
      throw error;
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<VectorSearchResult[]> {
    this.logger.info('Performing search', { query, options });
    
    // Generate embedding for the query
    const queryEmbedding = await this.vectorizationService.generateEmbedding(query);
    
    // Perform vector search
    return await this.databaseService.vectorSearch(queryEmbedding, options);
  }

  async syncAllTranscripts(limit?: number): Promise<SyncResult> {
    const batchSize = limit || 25;
    this.logger.info('Starting sync', { batchSize });
    
    const result: SyncResult = {
      success: true,
      processed: 0,
      failed: 0,
      errors: [],
    };

    try {
      const transcripts = await this.firefliesClient.getTranscripts(batchSize);
      
      // Process in parallel batches
      const parallelBatch = 3;
      for (let i = 0; i < transcripts.length; i += parallelBatch) {
        const batch = transcripts.slice(i, i + parallelBatch);
        
        await Promise.all(
          batch.map(async (transcript) => {
            try {
              await this.processTranscript(transcript.id);
              result.processed++;
            } catch (error) {
              result.failed++;
              result.errors?.push({
                transcript_id: transcript.id,
                error: (error as Error).message,
              });
            }
          })
        );
        
        // Add delay between batches
        if (i + parallelBatch < transcripts.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      this.logger.info('Sync completed', result);
    } catch (error) {
      this.logger.error('Sync failed', error as Error);
      result.success = false;
    }

    return result;
  }

  async getAnalytics(): Promise<AnalyticsData> {
    return await this.databaseService.getAnalytics();
  }

  async cleanup(): Promise<void> {
    await this.databaseService.cleanup();
  }
}

// ===== Webhook Handler =====
class WebhookHandler {
  private logger: Logger;

  constructor(private secret: string | undefined, logger: Logger) {
    this.logger = logger.child({ service: 'WebhookHandler' });
  }

  async verifySignature(request: Request): Promise<WebhookVerification> {
    if (!this.secret) {
      return { isValid: true };
    }

    const signature = request.headers.get('X-Fireflies-Signature');
    const timestamp = request.headers.get('X-Fireflies-Timestamp');
    
    if (!signature || !timestamp) {
      this.logger.warn('Missing webhook signature headers');
      return { isValid: false };
    }

    const body = await request.text();
    const message = `${timestamp}.${body}`;
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signatureBuffer = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(message)
    );
    
    const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    
    return {
      isValid: signature === expectedSignature,
      signature,
      timestamp,
    };
  }

  parsePayload(body: any): FirefliesWebhookPayload {
    return {
      event: body.event || 'transcript.created',
      transcript_id: body.transcript_id,
      timestamp: body.timestamp || new Date().toISOString(),
      data: body.data,
    };
  }
}

// ===== Main Worker Handler =====
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger('info');
    logger.setContext({ path: url.pathname, method: request.method });

    // Initialize services
    const processor = new TranscriptProcessor(env);
    const rateLimiter = new RateLimiter(
      env.CACHE,
      env.RATE_LIMIT_REQUESTS,
      env.RATE_LIMIT_WINDOW
    );

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Rate limiting (except for webhooks)
      if (!url.pathname.startsWith('/webhook')) {
        const clientId = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateLimit = await rateLimiter.checkLimit(clientId);
        
        if (!rateLimit.allowed) {
          return new Response(
            JSON.stringify({ error: 'Rate limit exceeded' }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                ...rateLimiter.getHeaders(rateLimit),
                'Content-Type': 'application/json',
              },
            }
          );
        }
      }

      // Route handlers
      switch (url.pathname) {
        case '/webhook/fireflies': {
          if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }

          const webhookHandler = new WebhookHandler(env.FIREFLIES_WEBHOOK_SECRET, logger);
          
          // Verify signature
          const verification = await webhookHandler.verifySignature(request.clone());
          if (!verification.isValid) {
            logger.warn('Invalid webhook signature');
            return new Response('Unauthorized', { status: 401 });
          }

          const body = await request.json<any>();
          const payload = webhookHandler.parsePayload(body);
          
          // Process asynchronously
          if (payload.transcript_id) {
            ctx.waitUntil(processor.processTranscript(payload.transcript_id));
          }

          return new Response(
            JSON.stringify({ success: true }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        case '/api/sync': {
          if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }

          const body = await request.json<any>();
          const limit = body.limit || env.SYNC_BATCH_SIZE;

          const result = await processor.syncAllTranscripts(limit);

          return new Response(
            JSON.stringify(result),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        case '/api/process': {
          if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }

          const body = await request.json<any>();
          if (!body.transcript_id) {
            return new Response('Missing transcript_id', { status: 400 });
          }

          await processor.processTranscript(body.transcript_id, body.options);

          return new Response(
            JSON.stringify({ 
              success: true, 
              message: `Processed transcript ${body.transcript_id}` 
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        case '/api/search': {
          if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }

          const body = await request.json<any>();
          if (!body.query) {
            return new Response('Missing query', { status: 400 });
          }

          const results = await processor.search(body.query, body.options);

          return new Response(
            JSON.stringify({ results }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        case '/api/analytics': {
          if (request.method !== 'GET') {
            return new Response('Method not allowed', { status: 405 });
          }

          const analytics = await processor.getAnalytics();

          return new Response(
            JSON.stringify(analytics),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        case '/api/health': {
          return new Response(
            JSON.stringify({ 
              status: 'healthy', 
              timestamp: new Date().toISOString(),
              version: '2.0.0',
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        }

        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error: any) {
      logger.error('Worker error', error);
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } finally {
      // Cleanup
      ctx.waitUntil(processor.cleanup());
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = new Logger('info');
    logger.info('Running scheduled sync', { cron: event.cron });
    
    const processor = new TranscriptProcessor(env);
    
    try {
      const result = await processor.syncAllTranscripts(env.SYNC_BATCH_SIZE);
      logger.info('Scheduled sync completed', result);
    } catch (error) {
      logger.error('Scheduled sync failed', error as Error);
    } finally {
      await processor.cleanup();
    }
  },
} satisfies ExportedHandler<Env>;