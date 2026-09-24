export const words = (text: string): readonly string[] => text.split(/\s+/).filter(word => word !== '');
