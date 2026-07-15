import { useState, FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const STORAGE_KEY = "lp_access";

/** Call this to check whether the passphrase gate has already been passed. */
export function isAccessGranted(): boolean {
  return sessionStorage.getItem(STORAGE_KEY) === "1";
}

/** Call this to clear the gate (e.g. on sign-out). */
export function clearAccess() {
  sessionStorage.removeItem(STORAGE_KEY);
}

interface PasscodeGateProps {
  onGranted: () => void;
}

export function PasscodeGate({ onGranted }: PasscodeGateProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${basePath}/api/verify-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: value }),
      });

      if (res.ok) {
        sessionStorage.setItem(STORAGE_KEY, "1");
        onGranted();
      } else {
        setError("Incorrect passphrase. Please try again.");
        setValue("");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: "hsl(155 42% 18%)" }}
    >
      <div className="flex flex-col items-center gap-8 w-full max-w-sm px-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <img
            src={`${basePath}/logo.svg`}
            alt="LeasePro"
            className="w-14 h-14 rounded-2xl"
          />
          <span
            className="font-serif font-semibold text-2xl tracking-tight"
            style={{ color: "hsl(60 9% 96%)" }}
          >
            LeasePro
          </span>
        </div>

        {/* Card */}
        <div className="w-full bg-white rounded-2xl shadow-xl border border-white/10 p-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1.5 text-center">
            <div className="flex justify-center mb-2">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ backgroundColor: "hsl(155 42% 18% / 0.08)" }}
              >
                <Lock className="w-5 h-5" style={{ color: "hsl(155 42% 18%)" }} />
              </div>
            </div>
            <h1 className="font-serif text-xl font-medium text-gray-900">
              Enter passphrase
            </h1>
            <p className="text-sm text-gray-500">
              This app is private. Enter the passphrase to continue.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              type="password"
              placeholder="Passphrase"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              required
              className="h-11"
            />

            {error && (
              <p className="text-sm text-red-600 text-center">{error}</p>
            )}

            <Button
              type="submit"
              className="h-11 w-full font-medium"
              style={{ backgroundColor: "hsl(155 42% 18%)" }}
              disabled={loading || !value}
            >
              {loading ? "Checking…" : "Continue"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
