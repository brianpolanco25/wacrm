import { describe, expect, it } from 'vitest';
import { aiReplyDispatchPlan } from './dispatch-gate';

const base = {
  flowConsumed: false,
  interactiveReplyId: null,
  inboundText: '',
  contentType: 'text',
  audioMediaId: undefined,
  accessToken: 'tok',
};

describe('aiReplyDispatchPlan (R4–R6)', () => {
  it('text → dispatch without voiceNote (R5)', () => {
    expect(aiReplyDispatchPlan({ ...base, inboundText: 'hola' })).toEqual({
      dispatch: true,
    });
  });

  it('blank text → no dispatch (R5)', () => {
    expect(aiReplyDispatchPlan({ ...base, inboundText: '   ' })).toEqual({
      dispatch: false,
    });
  });

  it('audio with a media id → dispatch with voiceNote (R4)', () => {
    expect(
      aiReplyDispatchPlan({ ...base, contentType: 'audio', audioMediaId: 'm1' })
    ).toEqual({
      dispatch: true,
      voiceNote: { metaMediaId: 'm1', accessToken: 'tok' },
    });
  });

  it('audio without a media id → no dispatch', () => {
    expect(aiReplyDispatchPlan({ ...base, contentType: 'audio' })).toEqual({
      dispatch: false,
    });
  });

  it('image/video/document without text → no dispatch (R5)', () => {
    for (const contentType of ['image', 'video', 'document']) {
      expect(
        aiReplyDispatchPlan({ ...base, contentType, audioMediaId: 'm1' })
      ).toEqual({ dispatch: false });
    }
  });

  it('flowConsumed or interactiveReplyId → no dispatch, even for audio (R6)', () => {
    const audio = { ...base, contentType: 'audio', audioMediaId: 'm1' };
    expect(aiReplyDispatchPlan({ ...audio, flowConsumed: true })).toEqual({
      dispatch: false,
    });
    expect(
      aiReplyDispatchPlan({ ...audio, interactiveReplyId: 'btn_1' })
    ).toEqual({ dispatch: false });
    expect(
      aiReplyDispatchPlan({ ...base, inboundText: 'hola', flowConsumed: true })
    ).toEqual({ dispatch: false });
  });
});
