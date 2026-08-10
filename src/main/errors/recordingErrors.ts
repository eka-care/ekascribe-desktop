export enum ErrorTypes {
  MICROPHONE_ACCESS_DENIED = 'MICROPHONE_ACCESS_DENIED',
  ERROR_ASKING_FOR_MICROPHONE_ACCESS = 'ERROR_ASKING_FOR_MICROPHONE_ACCESS',
}

export class RecordingError extends Error {
  constructor(message: string, public type: ErrorTypes) {
    super(`Recording failed: ${message}`);
    this.name = 'RecordingError';
    this.type = type;
  }
}