export function vehicleTags(name: string, styles: string[] = []) {
  const text = name.replace(/[_-]/g, ' '), body = styles.join(' ');
  if (/pickup|pick.up/i.test(body) || /\b(?:pickup|hilux|silverado|sierra|cybertruck|datsun|f\s?150|ram\s?1500)\b/i.test(text)) return ['pickup'];
  if (/\b(?:280zx|huracan|sian|mustang|challenger|camaro|corvette|supra|350z|370z)\b/i.test(text)) return ['coupe'];
  if (/\bsuv\b|sport.utility/i.test(body) || /\b(?:patrol|land\s?cruiser|prado|tahoe|suburban|sequoia|yukon|expedition|explorer|durango|pathfinder|range.rover|jimny|fj.cruiser|escalade|x[3567])\b/i.test(text)) return ['suv'];
  if (/sedan|saloon/i.test(body) || /\b(?:camry|corolla|cadenza|accord|sentra|azera|altima|accent|elantra|optima|sunny|impala|lumina|caprice|crown.victoria|marquis)\b/i.test(text)) return ['sedan'];
  if (/coupe|coupé|roadster/i.test(body)) return ['coupe'];
  if (/hatchback/i.test(body)) return ['hatchback'];
  return [];
}
