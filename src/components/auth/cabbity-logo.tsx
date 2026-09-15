import { cn } from '@/lib/utils';

/**
 * Cabbity brand mark — the leaping rabbit, traced from the official
 * `cabbity-icon.png` (106×74) into a single path. The viewBox is a square
 * with the mark centred vertically so `size-*` utilities keep it in
 * step with text. Painted in `currentColor`: a parent's `text-brand`
 * (or `text-white` on the favicon) sets the colour.
 */
export const CABBITY_MARK_PATH =
  'M104.9 35.5Q104.6 37.0 104.3 37.5Q104.0 38.1 102.5 38.7Q101.0 39.3 97.5 38.8Q94.0 38.3 89.5 36.3Q85.0 34.4 82.1 32.7Q79.2 31.0 78.9 30.5Q78.5 30.0 79.0 29.0Q79.5 28.0 79.5 27.0Q79.5 26.0 78.7 24.8Q78.0 23.6 76.0 23.1Q74.0 22.5 62.0 21.5Q50.0 20.4 45.5 19.4Q41.0 18.4 36.5 16.3Q32.0 14.2 30.3 12.6Q28.7 11.0 28.1 10.0Q27.5 9.0 30.3 8.6Q33.0 8.2 41.0 8.8Q49.0 9.5 49.9 9.2Q50.8 9.0 48.4 8.2Q46.0 7.3 44.2 6.2Q42.4 5.0 41.2 3.0Q39.9 1.0 40.5 0.4Q41.0 -0.2 46.5 -0.2Q52.0 -0.2 56.5 0.7Q61.0 1.7 65.5 4.2Q70.0 6.8 77.0 13.2Q84.0 19.5 89.0 20.6Q94.0 21.6 97.5 23.2Q101.0 24.7 102.7 26.9Q104.3 29.0 104.7 31.5Q105.2 34.0 104.9 35.5Z M52.7 10.0Q51.2 10.0 52.7 10.0Q54.1 10.0 52.7 10.0Z M55.2 10.8Q54.4 11.0 62.7 14.1Q71.0 17.2 73.2 17.6Q75.4 18.0 69.7 15.4Q64.0 12.8 60.0 11.7Q56.0 10.5 55.2 10.8Z M103.8 53.5Q105.3 56.0 104.7 56.2Q104.0 56.4 97.0 53.0Q90.0 49.7 84.0 48.2Q78.0 46.6 74.0 46.1Q70.0 45.5 62.0 45.6Q54.0 45.7 50.0 46.7Q46.0 47.7 42.6 49.4Q39.2 51.0 39.5 51.5Q39.8 52.0 43.4 52.3Q47.0 52.7 48.0 53.2Q49.0 53.6 49.0 54.0Q49.0 54.3 45.0 54.9Q41.0 55.6 33.5 57.7Q26.0 59.8 20.0 62.3Q14.0 64.9 7.5 68.8Q1.0 72.6 0.7 72.3Q0.3 72.0 4.7 66.8Q9.0 61.6 14.9 56.8Q20.7 52.0 20.4 51.6Q20.0 51.2 16.0 51.0Q12.0 50.8 11.5 50.4Q11.1 50.0 12.7 48.5Q14.2 47.0 18.1 43.8Q22.0 40.7 26.0 38.3Q30.0 35.9 35.0 33.9Q40.0 31.8 44.0 30.7Q48.0 29.7 52.5 29.3Q57.0 28.8 62.5 29.2Q68.0 29.6 74.5 31.6Q81.0 33.7 85.5 36.2Q90.0 38.7 93.0 41.2Q96.0 43.6 99.2 47.3Q102.4 51.0 103.8 53.5Z M7.7 41.5Q8.0 40.0 9.0 39.2Q10.0 38.5 11.8 38.7Q13.5 39.0 14.5 40.5Q15.4 42.0 14.9 43.5Q14.3 45.0 13.2 45.7Q12.0 46.3 10.5 45.9Q9.0 45.6 8.2 44.3Q7.4 43.0 7.7 41.5Z';

export const CABBITY_MARK_VIEWBOX = '0 -16 106 106';

export function CabbityMark({
  className,
  ...props
}: React.ComponentProps<'svg'>) {
  return (
    <svg
      viewBox={CABBITY_MARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn('size-10', className)}
      {...props}
    >
      <path d={CABBITY_MARK_PATH} />
    </svg>
  );
}

interface CabbityLogoProps {
  /** Small caption under the wordmark ("Tu negocio en orden"). */
  tagline?: string;
  /** Lockup direction. `row` is the header lockup, `column` the card one. */
  orientation?: 'row' | 'column';
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * Full lockup: mark + "Cabbity CRM" wordmark (+ optional tagline). The
 * wordmark is a proper noun and stays untranslated; the tagline is a
 * catalogue string so each locale reads its own.
 */
export function CabbityLogo({
  tagline,
  orientation = 'row',
  size = 'md',
  className,
}: CabbityLogoProps) {
  const large = size === 'lg';
  const taglineEl = tagline ? (
    <span className="text-navy/70 text-[0.68rem] font-semibold tracking-[0.28em] uppercase">
      {tagline}
    </span>
  ) : null;

  if (orientation === 'column') {
    return (
      <div
        className={cn('inline-flex flex-col items-center gap-1.5', className)}
      >
        <div className="flex items-center gap-2">
          <CabbityMark
            className={cn('text-brand', large ? 'size-12' : 'size-9')}
          />
          <span
            className={cn(
              'font-heading text-navy font-extrabold tracking-tight',
              large ? 'text-3xl' : 'text-2xl'
            )}
          >
            Cabbity CRM
          </span>
        </div>
        {taglineEl}
      </div>
    );
  }

  return (
    <div className={cn('inline-flex items-center gap-3', className)}>
      <CabbityMark
        className={cn('text-brand', large ? 'size-16' : 'size-10')}
      />
      <div className="flex flex-col">
        <span
          className={cn(
            'font-heading text-navy leading-none font-extrabold tracking-tight',
            large ? 'text-4xl' : 'text-3xl'
          )}
        >
          Cabbity CRM
        </span>
        {taglineEl ? <div className="mt-1.5 pl-0.5">{taglineEl}</div> : null}
      </div>
    </div>
  );
}
