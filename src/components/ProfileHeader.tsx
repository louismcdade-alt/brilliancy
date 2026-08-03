import type { Profile } from "../types";
import { SOURCE_LABEL } from "../types";
import { countryFlag, joinedYear } from "../lib/format";

export function ProfileHeader({ profile }: { profile: Profile }) {
  const flag = countryFlag(profile.country);
  const site = SOURCE_LABEL[profile.source];
  return (
    <div className="profile">
      {profile.avatar ? (
        <img className="profile-avatar" src={profile.avatar} alt="" loading="lazy" />
      ) : (
        <div className="profile-avatar" aria-hidden="true" />
      )}
      <div className="profile-id">
        <div className="profile-name">
          {/* Printed before the written name, the way a title is printed on the
              entry line of a pairing sheet. Both APIs carry it; Lichess is where
              it earns its place, since Lichess exposes no avatar and the header
              would otherwise be a bare handle. */}
          {profile.title && <span className="profile-title">{profile.title}</span>}
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
              {site} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
