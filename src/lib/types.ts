/** Shared types between frontend and (conceptually) Rust backend. */

export interface AudioDevice {
  id: string;
  name: string;
}

export interface AudioSession {
  pid: number;
  exe_name: string;
  display_name: string;
}

export type Role = 'all' | 'console' | 'multimedia' | 'communications';

export interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'error';
}

export interface RouteMemory {
  exe_name: string;
  device_id: string;
}
