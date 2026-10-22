#pragma once

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QString>
#include <QUrl>

// What to show the user when a request failed (2026-10-22 audit). Every service used to show
// Qt's own text - "Error transferring http://127.0.0.1:8766/api/activities?known_count=0 - server
// replied: Bad Gateway" - even though the backend's reply says what went wrong ("The watch isn't
// connected - plug it in with the cable, on its time screen, and try again."). Order:
//   1. the reply's own "error" text, when it has one - read with peek(), so the body stays there
//      for a caller that reads it afterwards;
//   2. for Sommet's own backend (127.0.0.1:8766), a plain sentence for the usual failures;
//   3. Qt's text, for anything else (intervals.icu, Garmin, ... speak for themselves).
inline QString backendErrorText(QNetworkReply *reply)
{
    if (!reply)
        return QString();
    const QJsonObject body = QJsonDocument::fromJson(reply->peek(reply->bytesAvailable())).object();
    const QString own = body.value(QStringLiteral("error")).toString().trimmed();
    if (!own.isEmpty())
        return own;

    const QUrl url = reply->url();
    const bool ownBackend = url.host() == QStringLiteral("127.0.0.1") && url.port() == 8766;
    if (ownBackend) {
        switch (reply->error()) {
        case QNetworkReply::ConnectionRefusedError:
        case QNetworkReply::RemoteHostClosedError:
            return QStringLiteral("Sommet's watch helper isn't running - close Sommet and open it again.");
        case QNetworkReply::TimeoutError:
        case QNetworkReply::OperationCanceledError:
            return QStringLiteral("The watch took too long to answer - check it's on its time screen and try again.");
        default:
            break;
        }
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (status == 502 || status == 503)
            return QStringLiteral("The watch didn't answer - check it's plugged in, on its time screen, and try again.");
        if (status == 409)
            return QStringLiteral("Testing mode is on, so nothing was sent to a watch.");
    }
    return reply->errorString();
}
