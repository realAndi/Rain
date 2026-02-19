import { describe, it, expect } from "vitest";
import {
  normalizeProfile,
  ensureDefaultProfile,
  deleteProfile,
  getProfiles,
  type ShellProfile,
} from "../profiles";

describe("normalizeProfile", () => {
  it("trims whitespace from name", () => {
    const profile: ShellProfile = { id: "1", name: "  My Profile  " };
    expect(normalizeProfile(profile).name).toBe("My Profile");
  });

  it("defaults empty name to 'Profile'", () => {
    const profile: ShellProfile = { id: "1", name: "" };
    expect(normalizeProfile(profile).name).toBe("Profile");
  });

  it("defaults whitespace-only name to 'Profile'", () => {
    const profile: ShellProfile = { id: "1", name: "   " };
    expect(normalizeProfile(profile).name).toBe("Profile");
  });

  it("trims shell path", () => {
    const profile: ShellProfile = { id: "1", name: "P", shell: " /bin/zsh " };
    expect(normalizeProfile(profile).shell).toBe("/bin/zsh");
  });

  it("converts empty shell to undefined", () => {
    const profile: ShellProfile = { id: "1", name: "P", shell: "  " };
    expect(normalizeProfile(profile).shell).toBeUndefined();
  });

  it("trims cwd", () => {
    const profile: ShellProfile = { id: "1", name: "P", cwd: " /home/user " };
    expect(normalizeProfile(profile).cwd).toBe("/home/user");
  });

  it("converts empty cwd to undefined", () => {
    const profile: ShellProfile = { id: "1", name: "P", cwd: "" };
    expect(normalizeProfile(profile).cwd).toBeUndefined();
  });

  it("trims env keys and converts values to strings", () => {
    const profile: ShellProfile = {
      id: "1",
      name: "P",
      env: { " FOO ": "bar", BAZ: "123" },
    };
    const result = normalizeProfile(profile);
    expect(result.env).toEqual({ FOO: "bar", BAZ: "123" });
  });

  it("strips env entries with empty keys", () => {
    const profile: ShellProfile = {
      id: "1",
      name: "P",
      env: { "": "value", " ": "value2", KEY: "val" },
    };
    const result = normalizeProfile(profile);
    expect(result.env).toEqual({ KEY: "val" });
  });

  it("converts empty env to undefined", () => {
    const profile: ShellProfile = {
      id: "1",
      name: "P",
      env: {},
    };
    expect(normalizeProfile(profile).env).toBeUndefined();
  });

  it("converts env with only blank keys to undefined", () => {
    const profile: ShellProfile = {
      id: "1",
      name: "P",
      env: { "": "val", "  ": "val2" },
    };
    expect(normalizeProfile(profile).env).toBeUndefined();
  });

  it("preserves icon and color", () => {
    const profile: ShellProfile = { id: "1", name: "P", icon: "star", color: "#ff0" };
    const result = normalizeProfile(profile);
    expect(result.icon).toBe("star");
    expect(result.color).toBe("#ff0");
  });
});

describe("ensureDefaultProfile", () => {
  it("keeps profiles that already include 'default'", () => {
    const profiles: ShellProfile[] = [
      { id: "default", name: "Default" },
      { id: "custom", name: "Custom" },
    ];
    const result = ensureDefaultProfile(profiles);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("default");
  });

  it("prepends default profile when missing", () => {
    const profiles: ShellProfile[] = [
      { id: "custom", name: "Custom" },
    ];
    const result = ensureDefaultProfile(profiles);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("default");
    expect(result[0].name).toBe("Default");
    expect(result[1].id).toBe("custom");
  });

  it("handles empty array", () => {
    const result = ensureDefaultProfile([]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("default");
  });

  it("normalizes all profiles", () => {
    const profiles: ShellProfile[] = [
      { id: "default", name: "  Default  " },
    ];
    const result = ensureDefaultProfile(profiles);
    expect(result[0].name).toBe("Default");
  });
});

describe("deleteProfile", () => {
  it("cannot delete the default profile", () => {
    getProfiles();
    const before = getProfiles().length;
    deleteProfile("default");
    expect(getProfiles().length).toBe(before);
    expect(getProfiles().some((p) => p.id === "default")).toBe(true);
  });
});
