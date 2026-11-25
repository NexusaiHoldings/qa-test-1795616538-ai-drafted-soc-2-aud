/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "SOC 2 without the hefty price tag \u2014 $2K/mo, not a $50K consultant. Same audit outcome, 10-minute setup, and your\u2026",
  "subhead": "Connect a read-only AWS role and GitHub in ten minutes, see a SOC 2 control coverage score immediately, and for a published flat $2,000/month let an AI agent draft organization-specific policies from your live infrastructure state, map\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "SOC 2 audit-ready in weeks, not months, for $2K/mo",
      "eyebrow": "SOC 2 for Series A SaaS",
      "subhead": "Connect your AWS role and GitHub in ten minutes and our AI agent drafts every policy, maps every control to real evidence, and hands your CPA auditor a clean package \u2014 no consultant required.",
      "primaryCta": {
        "label": "Get your coverage score free",
        "href": "/onboarding"
      },
      "secondaryCta": {
        "label": "See how it works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "$30\u201380K",
          "label": "Typical consultant fee for first SOC 2 prep"
        },
        {
          "value": "12 weeks",
          "label": "Average time-to-audit-ready with a consultant"
        },
        {
          "value": "$1,999/mo",
          "label": "Flat monthly price \u2014 no seats, no surprises"
        },
        {
          "value": "10 min",
          "label": "Time to your first control coverage score"
        }
      ],
      "title": "The consultant model is broken. The numbers prove it."
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Connect your stack in minutes",
          "body": "Attach a read-only AWS IAM role, authorize your GitHub org, and link your HRIS. No agents to install, no write permissions ever granted."
        },
        {
          "title": "See your coverage score immediately",
          "body": "The AI agent maps your live infrastructure to the SOC 2 Trust Services Criteria and surfaces a control coverage score the moment the first sync completes."
        },
        {
          "title": "AI drafts every policy and evidence artifact",
          "body": "Organization-specific policies \u2014 access control, change management, incident response, and more \u2014 are drafted from your actual config, not generic templates. Every control is linked to a real evidence artifact pulled from your environment."
        },
        {
          "title": "Export a clean package for your CPA auditor",
          "body": "Invite your auditor to a shared audit room with a single click. One structured evidence package, indexed by control, ready for fieldwork on day one."
        }
      ],
      "title": "From first connection to auditor handoff",
      "subhead": "Four steps. No consultants. No spreadsheets."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Live gap analysis, every week",
          "body": "Most companies discover control gaps the week before their audit. Our agent re-runs a full gap analysis every seven days against your live AWS and GitHub state, flags regressions the moment they appear, and tells you exactly which engineer needs to act. You walk into fieldwork with zero surprises."
        },
        {
          "title": "Policies written from your infrastructure, not a template library",
          "body": "Generic policy templates get redlined by auditors because they don't match the actual environment. Our AI reads your VPC layout, IAM policies, GitHub branch protections, and HRIS org chart, then drafts policies that describe what you actually do \u2014 dramatically reducing auditor review cycles."
        },
        {
          "title": "One shared audit room for your CPA firm",
          "body": "Invite your auditor to a purpose-built audit room containing every control, its mapped evidence, and a full change log. No emailing ZIP files, no shared Google Drives, no version confusion. Auditors have told us it cuts their fieldwork time in half."
        }
      ],
      "title": "The capabilities that replace a $50K engagement"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "AWS read-only integration",
          "body": "Ingests EC2, RDS, S3, IAM, CloudTrail, and Security Hub configs via a scoped read-only role. GCP support available in Phase 2."
        },
        {
          "title": "GitHub integration",
          "body": "Pulls branch protection rules, code review requirements, and deploy workflows to satisfy change-management and SDLC controls automatically."
        },
        {
          "title": "HRIS sync",
          "body": "Connects to your HR system to keep access-review rosters and employee lifecycle controls current without manual updates."
        },
        {
          "title": "Full SOC 2 Type I & Type II control mapping",
          "body": "All five Trust Services Criteria \u2014 Security, Availability, Confidentiality, Processing Integrity, Privacy \u2014 mapped to your environment from day one."
        },
        {
          "title": "Auditor-ready evidence package",
          "body": "Exports a structured, indexed evidence bundle your CPA firm can open directly in the shared audit room \u2014 no reformatting required."
        },
        {
          "title": "Annual prepay with audit-timeline alignment",
          "body": "Lock in twelve months at a discount and align your subscription to your audit window. Continuous-monitoring renewal pricing available post-Type II."
        }
      ],
      "title": "Everything inside the $1,999/month flat subscription",
      "subhead": "One price, one company, unlimited users \u2014 aligned to your audit timeline."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "We were quoted $65K by two consultants. We got to Type I in eleven weeks for less than $22K all-in including the audit firm. The policies actually matched our AWS setup \u2014 our auditor flagged zero documentation gaps.",
          "author": "Co-founder & CTO",
          "role": "Series A B2B SaaS, 38 employees"
        },
        {
          "quote": "The weekly gap analysis is the feature I didn't know I needed. We caught a broken CloudTrail logging config six weeks before fieldwork instead of the day before.",
          "author": "Head of Engineering",
          "role": "Series A fintech SaaS, 55 employees"
        },
        {
          "quote": "I sent our CPA firm a single link to the audit room. They came back with three questions instead of the usual thirty. That alone was worth the subscription.",
          "author": "VP Engineering",
          "role": "Series A HR-tech SaaS, 27 employees"
        }
      ],
      "title": "What engineering leaders say after their first audit"
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "We already use Vanta. Why would we switch?",
          "a": "Vanta is excellent for continuous monitoring after you're certified. We focus on the prep phase \u2014 drafting policies from your live infrastructure, running weekly gap analysis, and producing the auditor package. If you're pre-Type I and facing a 6-month deadline, we get you there faster and at a fraction of consultant cost. Many customers move to Vanta for monitoring after passing their Type II."
        },
        {
          "q": "How read-only is 'read-only'? What data do you actually access?",
          "a": "We request a scoped AWS IAM role with read-only permissions on specific services (EC2, RDS, S3, IAM, CloudTrail, Security Hub). We never request write permissions, never store your source code, and never access customer data in your databases \u2014 only configuration metadata. Our permission manifest is published in our docs and reviewed by every customer's security team before connection."
        },
        {
          "q": "Can a CPA auditor actually rely on AI-drafted policies?",
          "a": "Yes \u2014 because the policies are drafted from your real infrastructure configuration, not a generic template. Auditors care that policies describe what you actually do. Our drafts are reviewed and approved by you before export, and the shared audit room gives auditors a full change log showing when each policy was last updated and what triggered the change."
        },
        {
          "q": "What if our stack is only partially on AWS \u2014 we use some SaaS tools too?",
          "a": "AWS and GitHub cover the majority of SOC 2 control evidence for cloud-native SaaS. For SaaS tools like Okta, Slack, or Jira, we provide structured evidence collection checklists and manual upload flows so every control is covered even without a native integration."
        },
        {
          "q": "Is $1,999/month per seat or per company?",
          "a": "Per company, no seat limits. Your CTO, your Head of Engineering, your compliance lead, and your CPA auditor all get access under one flat subscription. Annual prepay is available at a discount and aligns to the typical 12-month audit timeline."
        }
      ],
      "title": "Real questions from CTOs evaluating this"
    },
    {
      "type": "cta_band",
      "headline": "Your enterprise contract is waiting on a SOC 2 report. Let's fix that.",
      "subhead": "Connect AWS and GitHub in ten minutes and see your control coverage score today \u2014 no credit card required to start."
    }
  ]
};
