interface PackageDetailPageProps {
  params: { packageId: string };
}
export default function PackageDetailPage({ params }: PackageDetailPageProps): JSX.Element {
  return (
    <main>
      <h1>Evidence Package</h1>
      <p className="muted">Package ID: {params.packageId}</p>
    </main>
  );
}
