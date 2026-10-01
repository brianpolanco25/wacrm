import {
  PricingPage,
  pricingMetadata,
  type PricingPageProps,
} from '@/components/pricing/pricing-page';

export const generateMetadata = (props: PricingPageProps) =>
  pricingMetadata(props);

export default function Page(props: PricingPageProps) {
  return <PricingPage {...props} />;
}
