import type { Profile } from "../types";
import { countryFlag, joinedYear } from "../lib/format";

export function ProfileHeader({ profile }: { profile: Profile }) {
  const flag = countryFlag(profile.country);
  return (
    <div className="profile">
      {profile.avatar ? (
        <img className="profile-avatar" src={profile.avatar} alt="" loading="lazy" />
      ) : (
        <div className="profile-avatar" aria-hidden="true" />
      )}
      <div className="profile-id">
        <div className="profile-name">
          {profile.name || profile.username}
          <span className="profile-handle">@{profile.username}</span>
        </div>
        <div className="profile-meta">
          {profile.isOnline && (
            <span>
              <span className="dot-online" />
              Online now
            </span>
          )}
          {(flag || profile.location) && (
            <span>
              {flag} {profile.location || ""}
            </span>
          )}
          {profile.joined && <span>Joined {joinedYear(profile.joined)}</span>}
          {typeof profile.followers === "number" && (
            <span>{profile.followers.toLocaleString()} followers</span>
          )}
          {profile.url && (
            <a href={profile.url} target="_blank" rel="noreferrer">
              chess.com ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
