import {
  LegalPage,
  legalMetadata,
  type LegalPageProps,
} from '@/components/legal/legal-page';

export const generateMetadata = (props: LegalPageProps) =>
  legalMetadata('terms', props);

export default function Page(props: LegalPageProps) {
  return <LegalPage slug="terms" {...props} />;
}
