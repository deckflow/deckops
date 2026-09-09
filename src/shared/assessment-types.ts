import type { QualityCheck } from '../ir/schema.js';
export interface QualityIssue extends QualityCheck {
  impact: 'content_missing' | 'structure_loss' | 'visual_loss' | 'delivery' | 'informational';
  evidenceKind: 'parser' | 'heuristic' | 'source_comparison';
  neededCapability?: string;
}
export interface Assessment {
  evaluatorVersion: 'rules.v1' | 'rules.v2';
  status: 'no_issue_detected' | 'needs_attention' | 'insufficient_evidence';
  issues: QualityIssue[];
  unassessed: string[];
  scope: { pages: number[]; sourcePageCount?: number };
  summary?: {
    sourcePages?: number; sourcePagesEvidence?: 'probe' | 'parser'; parsedPages: number;
    missingPages: number[]; missingPageCount: number; missingPagesTruncated?: boolean; failedPages: number[];
    searchableTextCharacters: number; textlessPages: number[]; ocrSuspectedPages: number[];
    visualRiskPages: number[]; controlCharacters: number;
  };
  recommendation?: { engine: 'cloud'; paid: true; uploadScope: 'entire_document'; reasonCodes: string[]; message: string };
}
