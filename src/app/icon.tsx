import { ImageResponse } from 'next/og';
import {
  CABBITY_MARK_PATH,
  CABBITY_MARK_VIEWBOX,
} from '@/components/auth/cabbity-logo';

// Replaces the default Next.js favicon with the brand mark — the Cabbity
// rabbit in white on the corporate amber (`--cb-token-brand`), the same
// path the auth screens draw via `CabbityMark`. Next.js renders this at
// build time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = 'edge';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F2A81B', // --cb-token-brand
        borderRadius: 6,
      }}
    >
      <svg width="26" height="26" viewBox={CABBITY_MARK_VIEWBOX} fill="#ffffff">
        <path d={CABBITY_MARK_PATH} />
      </svg>
    </div>,
    { ...size }
  );
}
