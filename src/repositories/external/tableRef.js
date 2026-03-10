function parseBigQueryTableRef(tableRef, defaultProjectId) {
  const parts = String(tableRef || '').split('.');
  if (parts.length === 3) {
    return {
      projectId: parts[0],
      datasetId: parts[1],
      tableId: parts[2],
      sqlRef: `\`${parts[0]}.${parts[1]}.${parts[2]}\``,
    };
  }
  if (parts.length === 2) {
    return {
      projectId: defaultProjectId,
      datasetId: parts[0],
      tableId: parts[1],
      sqlRef: `\`${defaultProjectId}.${parts[0]}.${parts[1]}\``,
    };
  }

  throw new Error(`Invalid BigQuery table reference: ${tableRef}`);
}

module.exports = {
  parseBigQueryTableRef,
};
