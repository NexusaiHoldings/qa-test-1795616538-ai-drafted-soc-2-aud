interface AuditRoomTokenPageProps {
  params: { token: string };
}
export default function AuditRoomTokenPage({ params }: AuditRoomTokenPageProps): JSX.Element {
  return (
    <main>
      <h1>Auditor View</h1>
      <p className="muted">Token: {params.token}</p>
    </main>
  );
}
