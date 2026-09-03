"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyParticipantState = exports.emptyStoryState = exports.emptyStorySetting = void 0;
const emptyStorySetting = () => ({
    character: { name: 'Unnamed character', profile: '' },
    user: { displayName: '', profile: '' },
    relationship: '', world: '', perspective: '', supportingCast: '', location: '',
    style: 'Realistic, restrained, and centered on ordinary life.',
    timezone: 'Asia/Shanghai',
});
exports.emptyStorySetting = emptyStorySetting;
const emptyStoryState = () => ({ settingOverlay: { characterTraits: [] }, automation: {}, narrativeUpdateCount: 0 });
exports.emptyStoryState = emptyStoryState;
const emptyParticipantState = () => ({
    openThreads: [], relationshipNotes: [], unreadMessageCount: 0, pendingReplyCount: 0,
});
exports.emptyParticipantState = emptyParticipantState;
