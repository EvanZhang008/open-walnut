/**
 * Jira REST API v3 types — subset used by the sync integration.
 */

import type { AdfDocument } from './adf.js';

// ── Issue ──

export interface JiraIssue {
  id: string;           // Numeric ID (e.g. "10042")
  key: string;          // Issue key (e.g. "CIS-123")
  self: string;         // API URL
  fields: JiraIssueFields;
}

export interface JiraIssueFields {
  summary: string;
  description: AdfDocument | null;
  status: JiraStatus;
  priority: JiraPriority | null;
  project: JiraProject;
  issuetype: JiraIssueType;
  created: string;      // ISO timestamp
  updated: string;      // ISO timestamp
  duedate: string | null;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  comment?: { comments: JiraComment[]; total: number };
  subtasks?: JiraIssue[];
  parent?: { id: string; key: string };
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    id: number;
    key: string;    // 'new' | 'indeterminate' | 'done' | 'undefined'
    name: string;
  };
}

export interface JiraPriority {
  id: string;
  name: string;        // "Highest", "High", "Medium", "Low", "Lowest"
}

export interface JiraIssueType {
  id: string;
  name: string;        // "Task", "Bug", "Story", "Sub-task", "Epic"
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;         // e.g. "CIS"
  name: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraComment {
  id: string;
  body: AdfDocument;
  created: string;     // ISO timestamp
  updated: string;     // ISO timestamp
  author: JiraUser;
}

// ── Transitions ──

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
}

// ── API request/response shapes ──

export interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface JiraCreateIssueInput {
  fields: {
    project: { key: string };
    summary: string;
    issuetype: { name: string };
    description?: AdfDocument;
    priority?: { name: string };
    duedate?: string;
    assignee?: { accountId: string };
    parent?: { key: string };
  };
}

export interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

export interface JiraUpdateIssueInput {
  fields: {
    summary?: string;
    description?: AdfDocument;
    priority?: { name: string };
    duedate?: string | null;
  };
}

export interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}
