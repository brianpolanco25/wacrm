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

  // n15.2: `image` left this list on purpose — a photo now dispatches
  // (n15.2 R1); see the n15.2 block below.
  it('video/document without text → no dispatch (R5)', () => {
    for (const contentType of ['video', 'document']) {
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

describe('aiReplyDispatchPlan — images (n15.2, R1–R3)', () => {
  const image = { ...base, contentType: 'image', imageMediaId: 'img1' };

  it('image with a media id and no text → dispatch with inboundImage (R1)', () => {
    expect(aiReplyDispatchPlan(image)).toEqual({
      dispatch: true,
      inboundImage: { metaMediaId: 'img1', accessToken: 'tok' },
    });
  });

  it('image with caption → dispatch with inboundImage (R2)', () => {
    expect(aiReplyDispatchPlan({ ...image, inboundText: 'mi cédula' })).toEqual(
      {
        dispatch: true,
        inboundImage: { metaMediaId: 'img1', accessToken: 'tok' },
      }
    );
  });

  it('image without id, sticker (no imageMediaId), video, document → no dispatch (R3)', () => {
    expect(aiReplyDispatchPlan({ ...image, imageMediaId: null })).toEqual({
      dispatch: false,
    });
    // A sticker is stored as content_type 'image' but the webhook never
    // passes its id as imageMediaId.
    expect(aiReplyDispatchPlan({ ...base, contentType: 'image' })).toEqual({
      dispatch: false,
    });
    for (const contentType of ['video', 'document']) {
      expect(
        aiReplyDispatchPlan({ ...base, contentType, imageMediaId: 'img1' })
      ).toEqual({ dispatch: false });
    }
  });

  it('flow consumed or interactive reply → no dispatch (R3)', () => {
    expect(aiReplyDispatchPlan({ ...image, flowConsumed: true })).toEqual({
      dispatch: false,
    });
    expect(
      aiReplyDispatchPlan({ ...image, interactiveReplyId: 'btn_1' })
    ).toEqual({ dispatch: false });
  });
});
