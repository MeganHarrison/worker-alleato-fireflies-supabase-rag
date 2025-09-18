// Type definitions for the Fireflies-Supabase RAG Worker

export interface Env {
  // Supabase Configuration
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  
  // Hyperdrive for PostgreSQL connection
  HYPERDRIVE: Hyperdrive;
  
  // Fireflies Configuration
  FIREFLIES_API_KEY: string;
  FIREFLIES_WEBHOOK_SECRET?: string;
  
  // Cloudflare AI
  AI: Ai;
  
  // KV Cache
  CACHE: KVNamespace;
  
  // Configuration Variables
  RATE_LIMIT_REQUESTS: number;
  RATE_LIMIT_WINDOW: number;
  SYNC_BATCH_SIZE: number;
  VECTOR_CACHE_TTL: number;
  ENABLE_REALTIME: boolean;
}

export interface TranscriptMetadata {
  id: string;
  title: string;
  date: string;
  duration: number;
  participants: string[];
  speakerCount: number;
  meetingType?: string;
  department?: string;
  project?: string;
  summary?: {
    keywords?: string[];
    action_items?: string[];
  };
  tags?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  importance?: 'low' | 'medium' | 'high';
}

export interface TranscriptChunk {
  transcript_id: string;
  chunk_index: number;
  text: string;
  speaker?: string;
  start_time?: number;
  end_time?: number;
  embedding?: number[];
  conversation_thread?: string;
}

export interface VectorSearchResult {
  chunk: TranscriptChunk;
  similarity: number;
  metadata: TranscriptMetadata;
  highlight?: string;
}

export interface FirefliesTranscript {
  id: string;
  title: string;
  transcript_url: string;
  duration: number;
  date: string;
  participants: string[];
  sentences?: {
    text: string;
    speaker_id: string;
    start_time: number;
  }[];
  summary?: {
    keywords?: string[];
    action_items?: string[];
    overview?: string;
    bullet_gist?: string[];
    outline?: string[];
    shorthand_bullet?: string[];
    gist?: string;
    short_summary?: string;
    short_overview?: string;
    topics_discussed?: string[];
  };
}

export interface FirefliesWebhookPayload {
  event: 'transcript.created' | 'transcript.updated' | 'transcript.deleted';
  transcript_id: string;
  timestamp: string;
  data?: {
    title?: string;
    date?: string;
    participants?: string[];
  };
}

export interface ProcessingOptions {
  maxChunkSize?: number;
  overlap?: number;
  bySpeaker?: boolean;
  generateSummary?: boolean;
  extractKeywords?: boolean;
  detectSentiment?: boolean;
}

export interface RateLimitInfo {
  key: string;
  requests: number;
  resetTime: number;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  filters?: {
    department?: string;
    project?: string;
    participants?: string[];
    dateFrom?: string;
    dateTo?: string;
    meetingType?: string;
  };
  includeHighlights?: boolean;
}

export interface SyncResult {
  success: boolean;
  processed: number;
  failed: number;
  errors?: Array<{
    transcript_id: string;
    error: string;
  }>;
}

export interface AnalyticsData {
  totalMeetings: number;
  totalDuration: number;
  averageDuration: number;
  topSpeakers: Array<{ name: string; count: number }>;
  topKeywords: Array<{ keyword: string; frequency: number }>;
  departmentBreakdown: Array<{ department: string; count: number }>;
  projectBreakdown: Array<{ project: string; count: number }>;
  sentimentAnalysis: {
    positive: number;
    neutral: number;
    negative: number;
  };
}

export interface ConversationThread {
  id: string;
  topic: string;
  chunks: string[];
  participants: string[];
  startTime: number;
  endTime: number;
  summary?: string;
}

export interface WebhookVerification {
  isValid: boolean;
  signature?: string;
  timestamp?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, any>;
  error?: Error;
}