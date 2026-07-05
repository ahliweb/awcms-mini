const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Expected a UUID, received: ${value}`);
  }

  return value;
}

export async function withTenant<T>(
  sql: Bun.SQL,
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  const safeTenantId = assertUuid(tenantId);

  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${safeTenantId}'`);

    return fn(tx);
  });
}
