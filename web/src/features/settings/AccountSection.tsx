/**
 * Settings → Account: who you're signed in as, your passkeys (add, rename,
 * remove; the last way to sign in can't be removed), Sign Out, and Delete
 * Account behind a confirmation. Data and actions: state/account.ts.
 * Hidden when nobody is signed in (the gate off, or the end-to-end harness).
 */
import { useId, useState } from "react";
import { Button, FormSection, GroupBox, Icon, Skeleton, formStyles } from "../../design/components";
import { authErrorMessage } from "../../auth/passkeys";
import { signInMethods, useAccount, useAccountActions, type Account, type AccountPasskey } from "../../state/account";
import styles from "./Settings.module.css";

type Action = Parameters<typeof authErrorMessage>[1];

const added = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function AccountSection() {
  const account = useAccount();
  if (account.isPending) {
    return (
      <FormSection title="Account" icon="person">
        <GroupBox>
          <div className={formStyles.row}>
            <Skeleton width={160} />
          </div>
        </GroupBox>
      </FormSection>
    );
  }
  if (account.isError) {
    return (
      <FormSection title="Account" icon="person">
        <GroupBox>
          <div className={formStyles.row}>
            <span className={formStyles.rowSubtitle}>Couldn't load your account. It will try again when you come back to Settings.</span>
          </div>
        </GroupBox>
      </FormSection>
    );
  }
  return account.data ? <AccountDetails account={account.data} /> : null;
}

function AccountDetails({ account }: { readonly account: Account }) {
  const actions = useAccountActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const errorID = useId();
  const lastMethod = signInMethods(account) <= 1;

  async function run(key: string, action: Action, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(authErrorMessage(e, action));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <FormSection title="Account" icon="person">
        <GroupBox label="Account">
          <div className={formStyles.row}>
            <div className={formStyles.rowText}>
              <span className={formStyles.rowTitle}>{account.user.name}</span>
              <span className={formStyles.rowSubtitle}>{account.user.email ?? (account.providers.includes("google") ? "Signed in with Google" : "Signed in with a passkey")}</span>
            </div>
            <Button disabled={busy !== null} onClick={() => void run("sign-out", "sign-out", actions.signOut)}>
              {busy === "sign-out" ? "Signing Out…" : "Sign Out"}
            </Button>
          </div>
        </GroupBox>
      </FormSection>

      <FormSection
        title="Passkeys"
        icon="shield"
        caption="A passkey signs you in with your fingerprint, face or device code. Add one on each device you use, or keep them in a password manager that syncs."
      >
        <GroupBox label="Passkeys">
          {account.passkeys.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              busy={busy}
              lastMethod={lastMethod}
              describedBy={error ? errorID : undefined}
              onRename={(name) => run(`rename:${passkey.id}`, "rename", () => actions.rename(passkey.id, name))}
              onRemove={() => run(`remove:${passkey.id}`, "remove", () => actions.remove(passkey))}
            />
          ))}
          <div className={formStyles.row}>
            <span style={{ flex: 1 }} className={formStyles.rowSubtitle}>
              {account.passkeys.length === 0 ? "No passkeys yet." : account.passkeys.length === 1 ? "1 passkey" : `${account.passkeys.length} passkeys`}
            </span>
            <Button disabled={busy !== null} onClick={() => void run("add", "add", actions.addPasskey)}>
              <Icon name="plusCircle" size={11} /> {busy === "add" ? "Adding…" : "Add a Passkey"}
            </Button>
          </div>
        </GroupBox>
        {error ? (
          <p id={errorID} className={styles.accountError} role="alert">
            {error}
          </p>
        ) : null}
      </FormSection>

      <FormSection title="Delete Account" icon="warning">
        <GroupBox label="Delete Account">
          {confirming ? (
            <div className={formStyles.row}>
              <div className={formStyles.rowText}>
                <span className={formStyles.rowTitle}>Delete your account?</span>
                <span className={formStyles.rowSubtitle}>Your passkeys stop working here and your synced settings are erased. This can't be undone. This device keeps its own settings.</span>
              </div>
              <div className={styles.accountActions}>
                <Button disabled={busy !== null} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button className={styles.destructive} disabled={busy !== null} onClick={() => void run("delete", "delete", () => actions.deleteAccount(account))}>
                  {busy === "delete" ? "Deleting…" : "Delete Account"}
                </Button>
              </div>
            </div>
          ) : (
            <div className={formStyles.row}>
              <div className={formStyles.rowText}>
                <span className={formStyles.rowTitle}>Delete Account</span>
                <span className={formStyles.rowSubtitle}>Erases your account, passkeys and synced settings.</span>
              </div>
              <Button className={styles.destructive} disabled={busy !== null} onClick={() => setConfirming(true)}>
                Delete Account…
              </Button>
            </div>
          )}
        </GroupBox>
      </FormSection>
    </>
  );
}

function PasskeyRow({
  passkey,
  busy,
  lastMethod,
  describedBy,
  onRename,
  onRemove,
}: {
  readonly passkey: AccountPasskey;
  readonly busy: string | null;
  readonly lastMethod: boolean;
  readonly describedBy?: string;
  readonly onRename: (name: string) => Promise<void>;
  readonly onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const fieldID = useId();
  const name = passkey.name ?? "Passkey";
  const subtitle = [passkey.createdAt ? `Added ${added.format(passkey.createdAt)}` : null, passkey.backedUp ? "Synced" : "This device only"].filter(Boolean).join(" · ");

  function save(value: string) {
    setEditing(false);
    const next = value.trim().slice(0, 64);
    if (next && next !== passkey.name) void onRename(next);
  }

  return (
    <div className={formStyles.row}>
      <div className={formStyles.rowText}>
        {editing ? (
          <>
            <label htmlFor={fieldID} className="visually-hidden">
              Passkey name
            </label>
            <input
              id={fieldID}
              className={styles.nameField}
              defaultValue={name}
              maxLength={64}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onBlur={(e) => save(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          </>
        ) : (
          <span className={formStyles.rowTitle}>{name}</span>
        )}
        <span className={formStyles.rowSubtitle}>{subtitle}</span>
      </div>
      {editing ? null : (
        <Button disabled={busy !== null} onClick={() => setEditing(true)} aria-label={`Rename ${name}`}>
          Rename
        </Button>
      )}
      <Button
        disabled={busy !== null || lastMethod}
        onClick={() => void onRemove()}
        aria-label={`Remove ${name}`}
        aria-describedby={describedBy}
        title={lastMethod ? "Add another passkey before removing this one: it's your only way to sign in." : undefined}
      >
        {busy === `remove:${passkey.id}` ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}
