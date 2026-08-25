import { create } from 'zustand';
import { listMeetings, type Meeting } from '../data/meetings';

interface MeetingsState {
  meetings: Meeting[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useMeetings = create<MeetingsState>((set) => ({
  meetings: [],
  loaded: false,
  refresh: async () => {
    const meetings = await listMeetings();
    set({ meetings, loaded: true });
  },
}));
