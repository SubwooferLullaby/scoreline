/**
 * Settings' way to /admin, shown only to admins: it asks the Worker
 * (`GET /api/admin/stats?probe`, which always answers 200 and runs no
 * queries) and draws nothing unless the answer is `{ admin: true }`.
 * /admin is linked from nowhere else.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { FormSection, GroupBox, Icon } from "../../design/components";
import settingsStyles from "../settings/Settings.module.css";

export function AdminLink() {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/stats?probe", { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ admin?: unknown }>) : null))
      .then((answer) => setAdmin(answer?.admin === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!admin) return null;
  return (
    <FormSection title="Owner" icon="shield">
      <GroupBox>
        <Link className={settingsStyles.catalogRow} to="/admin">
          <Icon name="shield" size={13} />
          <span className={settingsStyles.leagueName}>Admin</span>
          <Icon name="chevronRight" size={9} />
        </Link>
      </GroupBox>
    </FormSection>
  );
}
