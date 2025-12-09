export enum StudyStatus {
  IDLE = 'IDLE',
  STUDYING = 'STUDYING',
  DISTRACTED = 'DISTRACTED',
  ABSENT = 'ABSENT'
}

export interface AnalysisResult {
  status: StudyStatus;
  reason: string;
  confidence: number;
}

export interface StudySession {
  id: string;
  startTime: number; // Timestamp
  endTime: number;   // Timestamp
  duration: number;  // Seconds
  focusScore: number; // 0-100 percentage
  statusCounts: {
    studying: number;
    distracted: number;
    absent: number;
  };
}